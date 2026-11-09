import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { CanonicalPromotionInput } from "./canonical-pr-git";
import type { CanonicalPullRequest } from "./canonical-pr-api";

const mocked = vi.hoisted(() => ({
  api: vi.fn(),
  get: vi.fn(),
  find: vi.fn(),
  create: vi.fn(),
  promote: vi.fn(),
  repository: vi.fn(),
  sandbox: vi.fn(),
}));

vi.mock("./canonical-pr-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./canonical-pr-api")>()),
  createCanonicalPrApi: mocked.api,
}));
vi.mock("./canonical-pr-git", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./canonical-pr-git")>()),
  promoteCanonicalRefsWithWorkspace: mocked.promote,
}));
vi.mock("./source-delivery", () => ({ resolveSourceDeliveryRepository: mocked.repository }));
vi.mock("./source-delivery-sandbox", () => ({ withSourceGitSandbox: mocked.sandbox }));

import { CanonicalPrApiError } from "./canonical-pr-api";
import { CanonicalRefConflictError } from "./canonical-pr-git";
import { drainCanonicalPullRequests, publishCanonicalPullRequest } from "./canonical-pr-publisher";

type Operation = Tables<"session_pr_operations">;
type Epoch = Tables<"session_pr_epochs">;
type Response = { data: unknown; error: { message: string } | null };
type Pair = { headSha: string | null; fenceSha: string | null };

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const epochId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const runId = "55555555-5555-4555-8555-555555555555";
const repositoryId = "66666666-6666-4666-8666-666666666666";
const expectedHead = "a".repeat(40);
const desiredHead = "b".repeat(40);
const expectedFence = "c".repeat(40);
const desiredFence = "d".repeat(40);
const repositoryName = "acme/app";
const token = "synthetic-private-publisher-token";
const branchName = `wallie/sessions/${sessionId}/${epochId}`;
const fenceRef = `refs/wallie/fences/${epochId}`;
const sourceRef = `refs/wallie/checkpoints/${runId}/${desiredHead}`;

function response(data: unknown, error?: string): Response {
  return { data, error: error ? { message: error } : null };
}
function request(value: Response | Promise<Response>) {
  const promise = Promise.resolve(value);
  return Object.assign(promise, {
    abortSignal: vi.fn<(signal: AbortSignal) => Promise<Response>>(() => promise),
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function observationId(sequence: number): string {
  return `77777777-7777-4777-8777-${String(sequence).padStart(12, "0")}`;
}
function snapshot(state: CanonicalPullRequest["state"] = "open"): CanonicalPullRequest {
  return {
    number: 17,
    url: `https://github.com/${repositoryName}/pull/17`,
    state,
    draft: true,
    headSha: expectedHead,
    updatedAt: "2026-11-05T12:00:00.000Z",
  };
}
function samePair(left: Pair, right: Pair): boolean {
  return left.headSha === right.headSha && left.fenceSha === right.fenceSha;
}

/** Remote effects and database receipts deliberately survive separate drains. */
function makeState(input: { pinned?: boolean; terminal?: "closed" | "merged" } = {}) {
  const operation = {
    id: operationId,
    workspace_id: workspaceId,
    session_id: sessionId,
    epoch_id: epochId,
    checkpoint_run_id: runId,
    target_generation: 2,
    desired_sha: desiredHead,
    source_ref: sourceRef,
    expected_head_sha: expectedHead,
    expected_fence_sha: expectedFence,
    desired_fence_sha: desiredFence,
    fence_commit_body: `Wallie canonical publication ${operationId}\n`,
    status: "pending",
    claim_id: null,
    lease_expires_at: null,
    attempt_count: 0,
    next_attempt_at: "2026-11-05T12:00:00.000Z",
    last_error_code: null,
    receipt_head_sha: null,
    receipt_fence_sha: null,
    receipt_pr_number: null,
    receipt_pr_head_sha: null,
    receipt_pr_state: null,
    receipted_at: null,
    created_at: "2026-11-05T12:00:00.000Z",
  } as Operation;
  const epoch = {
    id: epochId,
    workspace_id: workspaceId,
    session_id: sessionId,
    epoch_number: 1,
    repository_id: repositoryId,
    repository_full_name: repositoryName,
    github_repository_id: 777,
    base_branch: "main",
    branch_name: branchName,
    fence_branch: fenceRef,
    pr_number: input.pinned ? 17 : null,
    pr_url: input.pinned ? `https://github.com/${repositoryName}/pull/17` : null,
    pr_state: input.pinned ? "open" : null,
    is_draft: input.pinned ? true : null,
    pr_updated_at: null,
    pr_head_sha: input.pinned ? expectedHead : null,
    create_attempted: false,
    acknowledged_head_sha: expectedHead,
    acknowledged_fence_sha: expectedFence,
    observation_id: null,
    created_at: "2026-11-05T12:00:00.000Z",
  } as Epoch;
  const state = {
    operation,
    epoch,
    current: true,
    targetCurrent: true,
    repositoryNumericId: 777,
    repositoryFullName: repositoryName,
    remote: { headSha: expectedHead, fenceSha: expectedFence } as Pair,
    pr: input.pinned || input.terminal ? snapshot(input.terminal) : null,
    session: { id: sessionId, workspace_id: workspaceId, title: "Implement the session feature" },
    sessionUnavailable: false,
    finishFailures: 0,
    ambiguousFinishes: 0,
    observationSequence: 0,
    claimWait: undefined as Promise<Response> | undefined,
    assertWait: undefined as Promise<Response> | undefined,
    failWait: undefined as Promise<Response> | undefined,
    afterGet: undefined as ((observed: CanonicalPullRequest) => void | Promise<void>) | undefined,
    createResult: "success" as "success" | "403" | "lost-open" | "lost-closed",
    beforePush: undefined as (() => void | Promise<void>) | undefined,
    afterPush: undefined as (() => void | Promise<void>) | undefined,
    events: [] as string[],
    writes: [] as Pair[],
    receipts: [] as Record<string, unknown>[],
    queries: [] as { table: string; filters: Record<string, unknown> }[],
  };
  const validClaim = (args: Record<string, unknown>) =>
    state.current &&
    state.targetCurrent &&
    !["closed", "merged"].includes(String(state.epoch.pr_state)) &&
    state.operation.status === "claimed" &&
    args.p_operation_id === state.operation.id &&
    args.p_claim_id === state.operation.claim_id;
  const rpc = vi.fn((name: string, args: Record<string, unknown> = {}) => {
    if (name === "claim_session_pr_sync") {
      state.events.push("claim");
      if (
        state.operation.status !== "pending" ||
        (args.p_session_id && args.p_session_id !== sessionId) ||
        !state.current ||
        !state.targetCurrent
      )
        return request(response(null));
      state.operation.status = "claimed";
      state.operation.claim_id = `claim-${++state.operation.attempt_count}`;
      state.operation.lease_expires_at = "2026-11-05T12:01:00.000Z";
      if (state.claimWait) return request(state.claimWait);
      return request(response(state.operation.claim_id));
    }
    if (name === "assert_session_pr_sync_claim") {
      state.events.push("assert");
      if (state.assertWait) return request(state.assertWait);
      return request(response(validClaim(args)));
    }
    if (name === "arm_session_pr_creation") {
      state.events.push("arm");
      const accepted =
        validClaim(args) && args.p_epoch_id === epochId && !state.epoch.create_attempted;
      if (accepted) state.epoch.create_attempted = true;
      return request(response(accepted));
    }
    if (name === "begin_session_pr_sync_observation") {
      state.events.push("observe");
      if (!validClaim(args)) return request(response(null));
      if (
        state.epoch.pr_number !== null &&
        (args.p_pr_number !== state.epoch.pr_number || args.p_pr_url !== state.epoch.pr_url)
      )
        return request(response(null));
      state.epoch.pr_number = args.p_pr_number as number;
      state.epoch.pr_url = args.p_pr_url as string;
      state.epoch.observation_id = observationId(++state.observationSequence);
      return request(response(state.epoch.observation_id));
    }
    if (name === "finish_session_pr_sync") {
      state.events.push("finish");
      if (!validClaim(args)) return request(response(false));
      if (!args.p_observation_id || args.p_observation_id !== state.epoch.observation_id)
        return request(response(false));
      if (state.finishFailures > 0) {
        state.finishFailures--;
        return request(response(null, "receipt unavailable"));
      }
      if (state.epoch.pr_number !== null && args.p_pr_number !== state.epoch.pr_number)
        return request(response(false));
      const terminal = args.p_pr_state !== "open";
      if (
        !terminal &&
        (args.p_observed_head_sha !== desiredHead ||
          args.p_observed_fence_sha !== desiredFence ||
          args.p_pr_head_sha !== desiredHead ||
          !samePair(state.remote, { headSha: desiredHead, fenceSha: desiredFence }))
      )
        return request(response(false));
      state.receipts.push({ ...args });
      state.epoch.pr_number = args.p_pr_number as number;
      state.epoch.pr_url = args.p_pr_url as string;
      state.epoch.pr_state = args.p_pr_state as string;
      state.epoch.pr_head_sha = args.p_pr_head_sha as string;
      state.epoch.pr_updated_at = args.p_pr_updated_at as string;
      state.epoch.observation_id = null;
      state.operation.status = terminal ? "terminal" : "succeeded";
      state.operation.receipt_head_sha = args.p_observed_head_sha as string | null;
      state.operation.receipt_fence_sha = args.p_observed_fence_sha as string | null;
      state.operation.receipt_pr_number = args.p_pr_number as number;
      state.operation.receipt_pr_state = args.p_pr_state as string;
      state.operation.claim_id = null;
      state.operation.lease_expires_at = null;
      if (state.ambiguousFinishes > 0) {
        state.ambiguousFinishes--;
        return request(response(null, "committed receipt response lost"));
      }
      return request(response(true));
    }
    if (name === "fail_session_pr_sync") {
      state.events.push("fail");
      if (state.failWait) return request(state.failWait);
      if (!validClaim(args)) return request(response(false));
      state.operation.status = args.p_is_conflict ? "conflict" : "pending";
      state.operation.last_error_code = args.p_error_code as string;
      state.operation.claim_id = null;
      state.operation.lease_expires_at = null;
      if (args.p_retry_creation_safe) state.epoch.create_attempted = false;
      return request(response(true));
    }
    throw new Error(`Unexpected canonical PR RPC ${name}`);
  });
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn((key: string, value: unknown) => {
        filters[key] = value;
        return chain;
      }),
      abortSignal: vi.fn(() => chain),
      single: vi.fn(() => {
        state.queries.push({ table, filters: { ...filters } });
        const row =
          table === "session_pr_operations"
            ? state.operation
            : table === "session_pr_epochs"
              ? state.epoch
              : table === "sessions" && !state.sessionUnavailable
                ? state.session
                : null;
        const matches =
          row &&
          Object.entries(filters).every(
            ([key, value]) => (row as Record<string, unknown>)[key] === value,
          );
        return request(response(matches ? { ...row } : null, matches ? undefined : "missing"));
      }),
    };
    return chain;
  });
  const admin = { rpc, from } as unknown as SupabaseClient<Database>;
  mocked.repository.mockImplementation(async () => {
    state.events.push("repository");
    return {
      repositoryNumericId: state.repositoryNumericId,
      token,
      delivery: { ...state.epoch, repository_full_name: state.repositoryFullName },
    };
  });
  mocked.api.mockReturnValue({ get: mocked.get, find: mocked.find, create: mocked.create });
  mocked.get.mockImplementation(async (number: number) => {
    state.events.push(`get:${number}`);
    if (!state.pr || state.pr.number !== number)
      throw new CanonicalPrApiError("pr_api_failed", { status: 404 });
    const observed = { ...state.pr };
    await state.afterGet?.(observed);
    return observed;
  });
  mocked.find.mockImplementation(async () => {
    state.events.push("find");
    return state.pr ? { ...state.pr } : null;
  });
  mocked.create.mockImplementation(async () => {
    state.events.push("post");
    const outcome = state.createResult;
    state.createResult = "success";
    if (outcome === "403")
      throw new CanonicalPrApiError("pr_creation_rejected", {
        retryCreationSafe: true,
        status: 403,
      });
    state.pr = { ...snapshot(outcome === "lost-closed" ? "closed" : "open"), headSha: desiredHead };
    if (outcome.startsWith("lost-")) throw new Error(`Response lost ${token}`);
    return { ...state.pr };
  });
  const dependencies = { execGit: vi.fn(), createWorkspace: vi.fn() };
  mocked.sandbox.mockImplementation(async (_signal, _context, execute) => execute(dependencies));
  mocked.promote.mockImplementation(async (args: CanonicalPromotionInput) => {
    state.events.push("promote");
    const desired = { headSha: args.desiredSha, fenceSha: args.desiredFenceSha };
    if (samePair(state.remote, desired)) return desired;
    if (!samePair(state.remote, { headSha: args.expectedHeadSha, fenceSha: args.expectedFenceSha }))
      throw new CanonicalRefConflictError();
    await state.beforePush?.();
    await args.beforePush?.();
    args.signal?.throwIfAborted();
    state.events.push("push");
    state.remote = desired;
    state.writes.push({ ...desired });
    if (state.pr) state.pr.headSha = args.desiredSha;
    await state.afterPush?.();
    return desired;
  });
  const claim = async () => {
    await admin.rpc("claim_session_pr_sync", { p_session_id: sessionId });
    return { ...state.operation };
  };
  const publish = async (signal = new AbortController().signal) =>
    publishCanonicalPullRequest(admin, await claim(), { ...state.epoch }, signal);
  return { state, admin, rpc, from, dependencies, claim, publish };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps an existing epoch on its original branch-backed fence", async () => {
  const { state, publish, dependencies } = makeState({ pinned: true });
  state.epoch.fence_branch = `wallie/session-fences/${epochId}`;
  await publish();
  expect(mocked.promote).toHaveBeenCalledWith(
    expect.objectContaining({ fenceRef: `refs/heads/wallie/session-fences/${epochId}` }),
    dependencies,
  );
});

it("updates only the pinned PR by GET and scopes every remote and receipt to the same operation", async () => {
  const { state, admin, rpc, dependencies } = makeState({ pinned: true });
  expect(await drainCanonicalPullRequests(admin, { sessionId, limit: 1 })).toEqual({
    processed: 1,
    failed: 0,
  });
  expect(mocked.get.mock.calls).toEqual([[17], [17], [17]]);
  expect(mocked.find).not.toHaveBeenCalled();
  expect(mocked.create).not.toHaveBeenCalled();
  expect(mocked.api).toHaveBeenCalledWith({
    repositoryFullName: repositoryName,
    repositoryNumericId: 777,
    branchName,
    baseBranch: "main",
    token,
    signal: expect.any(AbortSignal),
  });
  expect(mocked.repository).toHaveBeenCalledWith(
    admin,
    expect.objectContaining({
      id: epochId,
      workspace_id: workspaceId,
      repository_id: repositoryId,
    }),
    expect.any(AbortSignal),
  );
  expect(mocked.sandbox).toHaveBeenCalledWith(
    expect.any(AbortSignal),
    { admin, workspaceId, runId },
    expect.any(Function),
  );
  expect(mocked.promote).toHaveBeenCalledWith(
    expect.objectContaining({
      operationId,
      desiredSha: desiredHead,
      sourceRef,
      branchName,
      fenceRef,
      expectedHeadSha: expectedHead,
      expectedFenceSha: expectedFence,
      desiredFenceSha: desiredFence,
      remoteUrl: `https://github.com/${repositoryName}.git`,
      token,
    }),
    dependencies,
  );
  expect(rpc).toHaveBeenCalledWith(
    "finish_session_pr_sync",
    expect.objectContaining({
      p_operation_id: operationId,
      p_claim_id: "claim-1",
      p_observed_head_sha: desiredHead,
      p_observed_fence_sha: desiredFence,
      p_pr_number: 17,
      p_pr_state: "open",
      p_observation_id: observationId(1),
    }),
  );
  expect(rpc).toHaveBeenCalledWith("begin_session_pr_sync_observation", {
    p_operation_id: operationId,
    p_claim_id: "claim-1",
    p_pr_number: 17,
    p_pr_url: `https://github.com/${repositoryName}/pull/17`,
  });
  expect(state.events.indexOf("push")).toBeLessThan(state.events.indexOf("observe"));
  expect(state.events.indexOf("observe")).toBeLessThan(state.events.lastIndexOf("get:17"));
  expect(state.events.lastIndexOf("get:17")).toBeLessThan(state.events.indexOf("finish"));
  expect(state.operation.status).toBe("succeeded");
  expect(state.queries).toEqual(
    expect.arrayContaining([
      { table: "session_pr_operations", filters: { claim_id: "claim-1" } },
      {
        table: "session_pr_epochs",
        filters: { id: epochId, workspace_id: workspaceId, session_id: sessionId },
      },
    ]),
  );
});

it("never replaces a pinned PR after a 404", async () => {
  const { state, admin, rpc } = makeState({ pinned: true });
  state.pr = null;
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(mocked.get).toHaveBeenCalledExactlyOnceWith(17);
  expect(mocked.find).not.toHaveBeenCalled();
  expect(mocked.create).not.toHaveBeenCalled();
  expect(mocked.promote).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith(
    "fail_session_pr_sync",
    expect.objectContaining({ p_error_code: "pr_api_failed", p_retry_creation_safe: false }),
  );
  expect(state.epoch.pr_number).toBe(17);
});

it("records external ref conflicts before attempting PR creation", async () => {
  const { state, admin, rpc } = makeState();
  state.remote.headSha = "f".repeat(40);
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(state.writes).toEqual([]);
  expect(mocked.create).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("fail_session_pr_sync", {
    p_operation_id: operationId,
    p_claim_id: "claim-1",
    p_error_code: "external_ref_conflict",
    p_is_conflict: true,
    p_retry_creation_safe: false,
  });
  expect(state.operation.status).toBe("conflict");
});

it.each(["pr_identity_conflict", "pr_multiple_matches"] as const)(
  "treats %s API identity failures as conflicts without Git or POST",
  async (code) => {
    const { admin, rpc } = makeState();
    mocked.find.mockRejectedValueOnce(new CanonicalPrApiError(code));
    expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
      processed: 0,
      failed: 1,
    });
    expect(mocked.promote).not.toHaveBeenCalled();
    expect(mocked.create).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "fail_session_pr_sync",
      expect.objectContaining({ p_error_code: "external_ref_conflict", p_is_conflict: true }),
    );
  },
);

it.each(["closed", "merged"] as const)(
  "observes a %s pinned PR before opening a Git sandbox",
  async (terminal) => {
    const { state, admin, rpc } = makeState({ pinned: true, terminal });
    expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
      processed: 1,
      failed: 0,
    });
    expect(mocked.sandbox).not.toHaveBeenCalled();
    expect(mocked.promote).not.toHaveBeenCalled();
    expect(mocked.create).not.toHaveBeenCalled();
    expect(mocked.find).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      "finish_session_pr_sync",
      expect.objectContaining({
        p_pr_state: terminal,
        p_observed_head_sha: null,
        p_observed_fence_sha: null,
      }),
    );
    expect(state.operation.status).toBe("terminal");
  },
);

it("observes a close immediately before push and leaves both remote refs untouched", async () => {
  const { state, publish } = makeState({ pinned: true });
  state.beforePush = () => {
    state.pr!.state = "closed";
  };
  await expect(publish()).rejects.toThrow("became terminal");
  expect(state.writes).toEqual([]);
  expect(state.operation.status).toBe("terminal");
  expect(state.receipts).toContainEqual(
    expect.objectContaining({
      p_pr_state: "closed",
      p_observed_head_sha: null,
      p_observed_fence_sha: null,
    }),
  );
  expect(mocked.create).not.toHaveBeenCalled();
});

it("records a terminal race after the atomic push as terminal rather than synchronized", async () => {
  const { state, admin } = makeState({ pinned: true });
  state.afterPush = () => {
    state.pr!.state = "merged";
  };
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 1,
    failed: 0,
  });
  expect(state.writes).toEqual([{ headSha: desiredHead, fenceSha: desiredFence }]);
  expect(state.operation.status).toBe("terminal");
  expect(state.receipts).toContainEqual(
    expect.objectContaining({
      p_pr_state: "merged",
      p_observed_head_sha: desiredHead,
      p_observed_fence_sha: desiredFence,
    }),
  );
  expect(mocked.create).not.toHaveBeenCalled();
});

it("recovers the same operation and remote pair after remote success precedes a receipt failure", async () => {
  const { state, admin } = makeState();
  state.finishFailures = 1;
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(state.operation.status).toBe("pending");
  expect(state.epoch.pr_number).toBe(17);
  expect(state.pr?.number).toBe(17);
  expect(state.receipts).toEqual([]);
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 1,
    failed: 0,
  });
  expect(state.operation).toMatchObject({ id: operationId, attempt_count: 2, status: "succeeded" });
  expect(state.epoch.pr_number).toBe(17);
  expect(state.writes).toEqual([{ headSha: desiredHead, fenceSha: desiredFence }]);
  expect(mocked.create).toHaveBeenCalledOnce();
  expect(state.observationSequence).toBe(2);
  expect(state.receipts[0]).toHaveProperty("p_observation_id", observationId(2));
  expect(
    mocked.promote.mock.calls.map(([args]) => [
      args.operationId,
      args.desiredSha,
      args.desiredFenceSha,
    ]),
  ).toEqual([
    [operationId, desiredHead, desiredFence],
    [operationId, desiredHead, desiredFence],
  ]);
});

it("retains an accepted receipt after its response is lost without repeating remote effects", async () => {
  const { state, admin } = makeState();
  state.ambiguousFinishes = 1;
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(state.operation.status).toBe("succeeded");
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 0,
  });
  expect(state.receipts).toHaveLength(1);
  expect(state.writes).toHaveLength(1);
  expect(mocked.create).toHaveBeenCalledOnce();
});

it("pins the discovered PR before the final GET so a failed read cannot allow a replacement", async () => {
  const { state, admin } = makeState();
  mocked.get.mockRejectedValueOnce(new CanonicalPrApiError("pr_api_failed", { status: 404 }));
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(state.epoch).toMatchObject({
    pr_number: 17,
    pr_url: `https://github.com/${repositoryName}/pull/17`,
    observation_id: observationId(1),
  });
  expect(state.receipts).toEqual([]);
  state.pr = null;
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(mocked.create).toHaveBeenCalledOnce();
  expect(mocked.find).toHaveBeenCalledTimes(2);
  expect(mocked.get.mock.calls).toEqual([[17], [17]]);
});

it.each(["in progress", "completed"])(
  "cannot overwrite a newer %s webhook observation with an older publisher GET",
  async (newer) => {
    const { state, rpc, publish } = makeState({ pinned: true });
    const newerHead = "e".repeat(40);
    state.afterGet = () => {
      if (!state.epoch.observation_id) return;
      state.epoch.observation_id = newer === "in progress" ? observationId(99) : null;
      state.epoch.pr_head_sha = newerHead;
      state.epoch.pr_updated_at = "2026-11-05T12:00:01.000Z";
      state.afterGet = undefined;
    };
    await expect(publish()).rejects.toThrow("receipt could not be accepted");
    expect(rpc).toHaveBeenCalledWith(
      "finish_session_pr_sync",
      expect.objectContaining({ p_observation_id: observationId(1), p_pr_head_sha: desiredHead }),
    );
    expect(state.epoch.pr_head_sha).toBe(newerHead);
    expect(state.epoch.pr_updated_at).toBe("2026-11-05T12:00:01.000Z");
    expect(state.receipts).toEqual([]);
    expect(state.operation.status).toBe("claimed");
  },
);

it("keeps an observed terminal state sticky if the PR reopens before the final authoritative GET", async () => {
  const { state, admin } = makeState({ pinned: true, terminal: "closed" });
  state.afterGet = () => {
    state.pr!.state = "open";
  };
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 1,
    failed: 0,
  });
  expect(mocked.get.mock.calls).toEqual([[17], [17]]);
  expect(state.pr!.state).toBe("open");
  expect(state.epoch.pr_state).toBe("closed");
  expect(state.operation.status).toBe("terminal");
  expect(state.receipts).toContainEqual(
    expect.objectContaining({
      p_pr_state: "closed",
      p_observation_id: observationId(1),
      p_observed_head_sha: null,
      p_observed_fence_sha: null,
    }),
  );
  expect(mocked.promote).not.toHaveBeenCalled();
});

it.each(["lost-open", "lost-closed"] as const)(
  "recovers %s creation responses by finding all PR states",
  async (outcome) => {
    const { state, admin } = makeState();
    state.createResult = outcome;
    expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
      processed: 1,
      failed: 0,
    });
    expect(mocked.create).toHaveBeenCalledOnce();
    expect(mocked.find).toHaveBeenCalledTimes(3);
    expect(mocked.get).toHaveBeenCalledExactlyOnceWith(17);
    expect(state.epoch.pr_number).toBe(17);
    expect(state.operation.status).toBe(outcome === "lost-closed" ? "terminal" : "succeeded");
  },
);

it("keeps an uncertain durable creation arm GET-only on later attempts", async () => {
  const { state, admin, rpc } = makeState();
  state.epoch.create_attempted = true;
  for (let attempt = 0; attempt < 2; attempt++)
    expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
      processed: 0,
      failed: 1,
    });
  expect(mocked.find).toHaveBeenCalledTimes(4);
  expect(mocked.create).not.toHaveBeenCalled();
  expect(state.epoch.create_attempted).toBe(true);
  expect(rpc).toHaveBeenCalledWith(
    "fail_session_pr_sync",
    expect.objectContaining({
      p_error_code: "pr_creation_uncertain",
      p_is_conflict: false,
      p_retry_creation_safe: false,
    }),
  );
  expect(state.writes).toHaveLength(1);
});

it("rearms creation only after a definitive permission rejection and preserves its safe failure code", async () => {
  const { state, admin, rpc } = makeState();
  state.createResult = "403";
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(state.pr).toBeNull();
  expect(state.epoch.create_attempted).toBe(false);
  expect(rpc).toHaveBeenCalledWith("fail_session_pr_sync", {
    p_operation_id: operationId,
    p_claim_id: "claim-1",
    p_error_code: "pr_creation_rejected",
    p_is_conflict: false,
    p_retry_creation_safe: true,
  });
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 1,
    failed: 0,
  });
  expect(mocked.create).toHaveBeenCalledTimes(2);
  expect(state.epoch.pr_number).toBe(17);
  expect(state.writes).toHaveLength(1);
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(token);
});

it("preserves safe POST rejection evidence when the recovery GET also fails", async () => {
  const { state, admin, rpc } = makeState();
  state.createResult = "403";
  mocked.find
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new CanonicalPrApiError("pr_api_failed", { status: 503 }));
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(state.epoch.create_attempted).toBe(false);
  expect(rpc).toHaveBeenCalledWith(
    "fail_session_pr_sync",
    expect.objectContaining({ p_error_code: "pr_creation_rejected", p_retry_creation_safe: true }),
  );
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 1,
    failed: 0,
  });
  expect(mocked.create).toHaveBeenCalledTimes(2);
  expect(state.epoch.pr_number).toBe(17);
});

it("keeps uncertain POST attempts armed when the recovery GET fails", async () => {
  const { state, admin, rpc } = makeState();
  mocked.create.mockRejectedValueOnce(
    new CanonicalPrApiError("pr_creation_uncertain", { status: 502 }),
  );
  mocked.find
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new CanonicalPrApiError("pr_api_failed", { status: 503 }));
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(state.epoch.create_attempted).toBe(true);
  expect(rpc).toHaveBeenCalledWith(
    "fail_session_pr_sync",
    expect.objectContaining({
      p_error_code: "pr_creation_uncertain",
      p_retry_creation_safe: false,
    }),
  );
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(mocked.create).toHaveBeenCalledOnce();
  expect(state.epoch.create_attempted).toBe(true);
});

it("stores only a fixed failure code when a trusted transport error contains private material", async () => {
  const { admin, rpc } = makeState();
  mocked.promote.mockRejectedValueOnce(new Error(`Authorization: Bearer ${token}`));
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(rpc).toHaveBeenCalledWith(
    "fail_session_pr_sync",
    expect.objectContaining({ p_error_code: "publication_failed", p_retry_creation_safe: false }),
  );
  expect(JSON.stringify(rpc.mock.calls)).not.toContain(token);
  expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(token);
});

it("does not consume the creation arm when the session title cannot be loaded", async () => {
  const { state, admin } = makeState();
  state.sessionUnavailable = true;
  expect(await drainCanonicalPullRequests(admin, { limit: 1 })).toEqual({
    processed: 0,
    failed: 1,
  });
  expect(state.epoch.create_attempted).toBe(false);
  expect(mocked.create).not.toHaveBeenCalled();
});

it.each(["claim", "target"])(
  "refuses a stale %s immediately before external writes",
  async (changed) => {
    const { state, publish } = makeState({ pinned: true });
    state.beforePush = () => {
      if (changed === "claim") state.current = false;
      else state.targetCurrent = false;
    };
    await expect(publish()).rejects.toThrow("claim expired");
    expect(state.writes).toEqual([]);
    expect(state.receipts).toEqual([]);
    expect(mocked.create).not.toHaveBeenCalled();
  },
);

it("does not acknowledge or create a PR if the desired checkpoint changes after the Git push", async () => {
  const { state, rpc, publish } = makeState();
  state.afterPush = () => {
    state.targetCurrent = false;
  };
  await expect(publish()).rejects.toThrow("claim expired");
  expect(state.writes).toEqual([{ headSha: desiredHead, fenceSha: desiredFence }]);
  expect(state.receipts).toEqual([]);
  expect(mocked.create).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalledWith("arm_session_pr_creation", expect.anything());
  expect(rpc).not.toHaveBeenCalledWith("finish_session_pr_sync", expect.anything());
});

it.each(["id", "session_id", "workspace_id"] as const)(
  "rejects a foreign epoch %s before repository access",
  async (column) => {
    const { state, admin, claim } = makeState();
    const operation = await claim();
    await expect(
      publishCanonicalPullRequest(
        admin,
        operation,
        { ...state.epoch, [column]: "foreign" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("scope does not match");
    expect(mocked.repository).not.toHaveBeenCalled();
    expect(mocked.api).not.toHaveBeenCalled();
    expect(mocked.promote).not.toHaveBeenCalled();
  },
);

it.each(["numeric id", "full name"])(
  "rejects a changed repository %s before API or Git access",
  async (changed) => {
    const { state, publish } = makeState();
    if (changed === "numeric id") state.repositoryNumericId = 999;
    else state.repositoryFullName = "foreign/repository";
    await expect(publish()).rejects.toThrow("repository identity changed");
    expect(mocked.api).not.toHaveBeenCalled();
    expect(mocked.promote).not.toHaveBeenCalled();
  },
);

it("rejects another operation's claim before repository resolution", async () => {
  const { state, admin, claim } = makeState();
  const operation = await claim();
  await expect(
    publishCanonicalPullRequest(
      admin,
      { ...operation, id: "foreign-operation" },
      { ...state.epoch },
      new AbortController().signal,
    ),
  ).rejects.toThrow("claim expired");
  expect(mocked.repository).not.toHaveBeenCalled();
});

it("refuses a terminal database epoch even when a remote snapshot appears open", async () => {
  const { state, publish } = makeState({ pinned: true });
  state.epoch.pr_state = "closed";
  await expect(publish()).rejects.toThrow();
  expect(mocked.repository).not.toHaveBeenCalled();
  expect(mocked.api).not.toHaveBeenCalled();
  expect(mocked.promote).not.toHaveBeenCalled();
  expect(state.receipts).toEqual([]);
});

it("does not acknowledge a remote push after cancellation", async () => {
  const { state, rpc, publish } = makeState({ pinned: true });
  const controller = new AbortController();
  state.afterPush = () => controller.abort(new Error("Worker deadline expired"));
  await expect(publish(controller.signal)).rejects.toThrow("Worker deadline expired");
  expect(state.writes).toHaveLength(1);
  expect(state.receipts).toEqual([]);
  expect(rpc).not.toHaveBeenCalledWith("finish_session_pr_sync", expect.anything());
  expect(mocked.create).not.toHaveBeenCalled();
});

it("does not release or acknowledge a claim after its maintenance deadline aborts", async () => {
  vi.useFakeTimers();
  const { state, admin, rpc } = makeState({ pinned: true });
  mocked.promote.mockImplementationOnce(async (args: CanonicalPromotionInput) => {
    await args.beforePush?.();
    await new Promise<void>((resolve) =>
      args.signal!.addEventListener("abort", () => resolve(), { once: true }),
    );
    args.signal!.throwIfAborted();
  });
  const draining = drainCanonicalPullRequests(admin, { limit: 1, timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect(await draining).toEqual({ processed: 0, failed: 1 });
  expect(state.operation.status).toBe("claimed");
  expect(rpc).not.toHaveBeenCalledWith("finish_session_pr_sync", expect.anything());
  expect(rpc).not.toHaveBeenCalledWith("fail_session_pr_sync", expect.anything());
});

it("bounds a claim transport that ignores abort and fences its late successful reply", async () => {
  vi.useFakeTimers();
  const { state, admin, rpc } = makeState({ pinned: true });
  const claimed = deferred<Response>();
  state.claimWait = claimed.promise;
  const draining = drainCanonicalPullRequests(admin, { limit: 1, timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(100);
  expect(await draining).toEqual({ processed: 0, failed: 1 });
  expect(state.operation.status).toBe("claimed");
  claimed.resolve(response("claim-1"));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocked.repository).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalledWith("finish_session_pr_sync", expect.anything());
  expect(rpc).not.toHaveBeenCalledWith("fail_session_pr_sync", expect.anything());
});

it("bounds a failure receipt transport that ignores abort", async () => {
  vi.useFakeTimers();
  const { state, admin, rpc } = makeState({ pinned: true });
  const failed = deferred<Response>();
  state.failWait = failed.promise;
  mocked.promote.mockRejectedValueOnce(new Error("Git unavailable"));
  const draining = drainCanonicalPullRequests(admin, { limit: 1, timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(0);
  expect(rpc).toHaveBeenCalledWith(
    "fail_session_pr_sync",
    expect.objectContaining({ p_operation_id: operationId, p_claim_id: "claim-1" }),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await draining).toEqual({ processed: 0, failed: 1 });
  const failureIndex = rpc.mock.calls.findIndex(([name]) => name === "fail_session_pr_sync");
  const failureRequest = rpc.mock.results[failureIndex].value;
  expect(failureRequest.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(failureRequest.abortSignal.mock.calls[0][0].aborted).toBe(true);
  failed.resolve(response(false));
  await vi.advanceTimersByTimeAsync(0);
  expect(state.receipts).toEqual([]);
  expect(rpc).not.toHaveBeenCalledWith("finish_session_pr_sync", expect.anything());
});

it("does not finish after the final claim assertion returns success beyond its lease deadline", async () => {
  vi.useFakeTimers();
  const { state, admin, rpc } = makeState({ pinned: true });
  const asserted = deferred<Response>();
  state.afterGet = () => {
    if (state.epoch.observation_id) state.assertWait = asserted.promise;
  };
  const draining = drainCanonicalPullRequests(admin, { limit: 1, timeoutMs: 100 });
  await vi.advanceTimersByTimeAsync(0);
  expect(state.epoch.observation_id).toBe(observationId(1));
  expect(state.events.at(-1)).toBe("assert");
  await vi.advanceTimersByTimeAsync(100);
  expect(await draining).toEqual({ processed: 0, failed: 1 });
  asserted.resolve(response(true));
  await vi.advanceTimersByTimeAsync(0);
  expect(state.writes).toHaveLength(1);
  expect(state.receipts).toEqual([]);
  expect(rpc).not.toHaveBeenCalledWith("finish_session_pr_sync", expect.anything());
  expect(rpc).not.toHaveBeenCalledWith("fail_session_pr_sync", expect.anything());
});

it("claims only the requested session and stops after accepting its receipt", async () => {
  const { state, admin, rpc } = makeState({ pinned: true });
  expect(
    await drainCanonicalPullRequests(admin, { sessionId: "foreign-session", limit: 1 }),
  ).toEqual({ processed: 0, failed: 0 });
  expect(mocked.repository).not.toHaveBeenCalled();
  expect(await drainCanonicalPullRequests(admin, { sessionId, limit: 3 })).toEqual({
    processed: 1,
    failed: 0,
  });
  expect(state.receipts).toHaveLength(1);
  expect(
    rpc.mock.calls.filter(([name]) => name === "claim_session_pr_sync").map(([, args]) => args),
  ).toEqual([
    { p_session_id: "foreign-session" },
    { p_session_id: sessionId },
    { p_session_id: sessionId },
  ]);
});
