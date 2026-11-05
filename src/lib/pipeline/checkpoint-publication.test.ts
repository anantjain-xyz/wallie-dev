import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { SourceRestoreInput } from "./source-delivery-git-core";
import type { SourceDelivery } from "./source-delivery";

const mocked = vi.hoisted(() => ({
  bundle: vi.fn(),
  repository: vi.fn(),
  push: vi.fn(),
  pr: vi.fn(),
}));
vi.mock("./source-delivery", () => ({
  readSourceDeliveryBundle: mocked.bundle,
  resolveSourceDeliveryRepository: mocked.repository,
}));
vi.mock("./source-delivery-sandbox", () => ({ restoreAndPushSourceInSandbox: mocked.push }));
vi.mock("./source-pull-request", () => ({ ensureSourcePullRequest: mocked.pr }));

import {
  adoptCheckpointPublication,
  CheckpointPublicationPendingError,
  drainCheckpointPublications,
  publishSessionCheckpoint,
  type CheckpointPublication,
} from "./checkpoint-publication";

const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const retainedRef = `refs/heads/wallie/checkpoints/run/${headSha}`;
const bytes = Buffer.from("durable private Git bundle");
const markdown = "# Complete output\n\nOriginal artifact body.";
const deadlineAt = "2026-11-05T12:30:00.000Z";

type Publication = CheckpointPublication & {
  status: "pending" | "claimed" | "adopted" | "stale";
};

type Response = { data: unknown; error: { message: string } | null };
const response = (data: unknown, error: string | null = null): Response => ({
  data,
  error: error ? { message: error } : null,
});
function request(value: Response | Promise<Response>) {
  const promise = Promise.resolve(value);
  return Object.assign(promise, { abortSignal: vi.fn(() => promise) });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => (resolve = complete));
  return { promise, resolve };
}

/** These receipts survive transport failures and repeated maintenance invocations. */
function makeState(input: { noCode?: boolean; prepared?: boolean } = {}) {
  const state = {
    publication: null as Publication | null,
    source: {
      run_id: "run",
      workspace_id: "workspace",
      session_id: "session",
      job_id: "job",
      attempt_count: 2,
      repository_id: "repository",
      installation_id: 12,
      repository_full_name: "acme/app",
      branch_name: "wallie/source-delivery",
      base_branch: "main",
      base_sha: baseSha,
      head_sha: input.noCode ? baseSha : headSha,
      bundle_sha256: "c".repeat(64),
      bundle_base64: bytes.toString("base64"),
      checkpoint_path: "workspace/run.bundle",
      status: "pending",
    } as SourceDelivery | null,
    artifacts: [] as { id: string; body: string }[],
    remoteRefs: new Map<string, string>(),
    events: [] as string[],
    current: true,
    expired: false,
    prepareFailure: false,
    adoptionFailures: 0,
    ambiguousAdoptions: 0,
    releaseFailure: false,
    releaseWait: undefined as Promise<Response> | undefined,
    statusReadWait: undefined as Promise<Response> | undefined,
  };
  const prepare = (args: Record<string, unknown>) => {
    state.events.push("prepare");
    if (!state.publication) {
      state.publication = {
        run_id: "run",
        workspace_id: "workspace",
        session_id: "session",
        job_id: "job",
        attempt_count: 2,
        artifact_md: args.p_artifact_md as string,
        expected_artifact_version: args.p_expected_artifact_version as number,
        deadline_at: (args.p_deadline_at as string | undefined) ?? deadlineAt,
        retained_ref: input.noCode ? null : retainedRef,
        status: "pending",
        claim_id: null,
        lease_expires_at: null,
        publication_attempt_count: 0,
        artifact_id: null,
        remote_verified_ref: null,
        remote_verified_sha: null,
        remote_verified_at: null,
        next_attempt_at: "2026-11-05T12:00:00.000Z",
        last_error_code: null,
        created_at: "2026-11-05T12:00:00.000Z",
        adopted_at: null,
      };
    }
    const same =
      state.publication.artifact_md === args.p_artifact_md &&
      state.publication.expected_artifact_version === args.p_expected_artifact_version &&
      (!args.p_deadline_at || state.publication.deadline_at === args.p_deadline_at);
    return response(
      same,
      !same
        ? "publication intent is immutable"
        : state.prepareFailure
          ? "prepare response lost"
          : null,
    );
  };
  const validClaim = (args: Record<string, unknown>) =>
    state.current &&
    !state.expired &&
    state.publication?.status === "claimed" &&
    state.publication.claim_id === args.p_claim_id &&
    state.publication.run_id === args.p_run_id;
  const rpc = vi.fn((name: string, args: Record<string, unknown> = {}) => {
    if (name === "prepare_session_checkpoint_publication") return request(prepare(args));
    if (name === "claim_session_checkpoint_publication") {
      state.events.push("claim");
      const row = state.publication;
      if (!row || row.status !== "pending" || (args.p_run_id && args.p_run_id !== row.run_id))
        return request(response(null));
      if (!state.current || state.expired) {
        row.status = "stale";
        return request(response(null));
      }
      row.status = "claimed";
      row.claim_id = `claim-${++row.publication_attempt_count}`;
      row.lease_expires_at = deadlineAt;
      return request(response(row.claim_id));
    }
    if (name === "assert_session_checkpoint_publication_claim") {
      state.events.push("assert");
      return request(response(validClaim(args)));
    }
    if (name === "adopt_session_checkpoint_publication") {
      state.events.push("adopt");
      if (!validClaim(args)) return request(response(false));
      if (state.adoptionFailures-- > 0) return request(response(null, "commit unavailable"));
      const row = state.publication!;
      if (row.retained_ref) {
        if (
          args.p_remote_ref !== row.retained_ref ||
          args.p_remote_sha !== state.source?.head_sha ||
          state.remoteRefs.get(row.retained_ref) !== args.p_remote_sha
        )
          return request(response(false));
        row.remote_verified_ref = args.p_remote_ref as string;
        row.remote_verified_sha = args.p_remote_sha as string;
        row.remote_verified_at = "2026-11-05T12:00:01.000Z";
      } else if (args.p_remote_ref || args.p_remote_sha) return request(response(false));
      row.artifact_id = `artifact-${state.artifacts.length + 1}`;
      state.artifacts.push({ id: row.artifact_id, body: row.artifact_md });
      row.status = "adopted";
      row.adopted_at = "2026-11-05T12:00:01.000Z";
      return request(
        response(true, state.ambiguousAdoptions-- > 0 ? "committed response lost" : null),
      );
    }
    if (name === "release_session_checkpoint_publication") {
      state.events.push("release");
      if (state.releaseWait) return request(state.releaseWait);
      if (state.releaseFailure) return request(response(null, "release unavailable"));
      if (
        !state.current &&
        state.publication?.status === "claimed" &&
        state.publication.claim_id === args.p_claim_id
      ) {
        state.publication.status = "stale";
        state.publication.claim_id = null;
        state.publication.lease_expires_at = null;
        return request(response(false));
      }
      if (!validClaim(args)) return request(response(false));
      state.publication!.status = "pending";
      state.publication!.claim_id = null;
      state.publication!.lease_expires_at = null;
      return request(response(true));
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const from = vi.fn((table: string) => {
    const filters = new Map<string, unknown>();
    const read = (single: boolean) => {
      if (table === "session_checkpoint_publications" && filters.has("run_id")) {
        state.events.push("receipt");
        if (state.statusReadWait) return request(state.statusReadWait);
      }
      const row =
        table === "session_checkpoint_publications"
          ? state.publication
          : table === "session_source_deliveries"
            ? state.source
            : null;
      const matches =
        row &&
        [...filters].every(([key, value]) => (row as Record<string, unknown>)[key] === value);
      return request(response(matches ? { ...row } : null, single && !matches ? "missing" : null));
    };
    const chain = {
      select: vi.fn(() => chain),
      eq: vi.fn((key: string, value: unknown) => {
        filters.set(key, value);
        return chain;
      }),
      abortSignal: vi.fn(() => chain),
      single: vi.fn(() => read(true)),
      maybeSingle: vi.fn(() => read(false)),
    };
    return chain;
  });
  const admin = { rpc, from } as unknown as SupabaseClient<Database>;
  const publish = (overrides: Partial<Parameters<typeof publishSessionCheckpoint>[0]> = {}) =>
    publishSessionCheckpoint({
      admin,
      runId: "run",
      jobId: "job",
      attemptCount: 2,
      workspaceId: "workspace",
      expectedArtifactVersion: 4,
      artifactMarkdown: markdown,
      deadlineAt,
      ...overrides,
    });
  if (input.prepared)
    prepare({ p_artifact_md: markdown, p_expected_artifact_version: 4, p_deadline_at: deadlineAt });
  mocked.bundle.mockImplementation(async () => {
    state.events.push("bundle");
    return bytes;
  });
  mocked.repository.mockImplementation(async () => {
    state.events.push("repository");
    return { token: "scoped-token", delivery: state.source };
  });
  mocked.push.mockImplementation(async (args: SourceRestoreInput) => {
    await args.beforePush?.();
    args.signal?.throwIfAborted();
    state.events.push("push");
    state.remoteRefs.set(`refs/heads/${args.branch}`, args.headSha);
    return args.branch;
  });
  return { state, admin, rpc, from, publish };
}

async function claimed(input: Parameters<typeof makeState>[0] = {}) {
  const result = makeState({ ...input, prepared: true });
  await result.admin.rpc("claim_session_checkpoint_publication", { p_run_id: "run" });
  return {
    ...result,
    publication: { ...result.state.publication! },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("prepares the immutable original output before publishing and adopts only its exact retained ref", async () => {
  const { state, rpc, publish } = makeState();
  expect(await publish()).toBe("adopted");
  expect(state.events.indexOf("prepare")).toBeLessThan(state.events.indexOf("push"));
  expect(state.events.indexOf("push")).toBeLessThan(state.events.indexOf("adopt"));
  expect(mocked.push).toHaveBeenCalledWith(
    expect.objectContaining({
      baseSha,
      headSha,
      branch: retainedRef.slice("refs/heads/".length),
      exactRef: true,
      bytes,
      remoteUrl: "https://github.com/acme/app.git",
      token: "scoped-token",
    }),
    expect.objectContaining({ runId: "run", workspaceId: "workspace" }),
  );
  expect(rpc).toHaveBeenCalledWith("adopt_session_checkpoint_publication", {
    p_run_id: "run",
    p_claim_id: "claim-1",
    p_remote_ref: retainedRef,
    p_remote_sha: headSha,
  });
  expect(state.artifacts).toEqual([{ id: "artifact-1", body: markdown }]);
  expect(mocked.pr).not.toHaveBeenCalled();
});

it("keeps the prepared intent and private bundle pending when the remote is unavailable", async () => {
  const { state, rpc, publish } = makeState();
  mocked.push.mockRejectedValueOnce(new Error("Git unavailable"));
  expect(await publish()).toBe("pending");
  expect(state.publication).toMatchObject({ status: "pending", artifact_md: markdown });
  expect(state.source?.bundle_base64).toBe(bytes.toString("base64"));
  expect(state.source?.checkpoint_path).toBe("workspace/run.bundle");
  expect(state.artifacts).toEqual([]);
  expect(rpc.mock.calls.some(([name]) => name === "adopt_session_checkpoint_publication")).toBe(
    false,
  );
});

it("reuses the pushed candidate after a failed adoption transaction and creates one artifact", async () => {
  const { state, admin, publish } = makeState();
  state.adoptionFailures = 1;
  expect(await publish()).toBe("pending");
  expect(state.remoteRefs).toEqual(new Map([[retainedRef, headSha]]));
  expect(state.artifacts).toEqual([]);
  expect(await drainCheckpointPublications(admin, { runId: "run", limit: 1 })).toEqual({
    adopted: 1,
    failed: 0,
  });
  expect(state.remoteRefs.size).toBe(1);
  expect(
    mocked.push.mock.calls.map(([args]) => [args.branch, args.headSha, args.exactRef]),
  ).toEqual([
    [retainedRef.slice("refs/heads/".length), headSha, true],
    [retainedRef.slice("refs/heads/".length), headSha, true],
  ]);
  expect(state.artifacts).toEqual([{ id: "artifact-1", body: markdown }]);
  expect(state.publication?.publication_attempt_count).toBe(2);
  expect(state.events.filter((event) => event === "prepare")).toHaveLength(1);
});

it("reads the durable adoption receipt after a lost commit response without creating a second artifact", async () => {
  const { state, publish } = makeState();
  state.ambiguousAdoptions = 1;
  expect(await publish()).toBe("adopted");
  expect(state.events.indexOf("adopt")).toBeLessThan(state.events.indexOf("receipt"));
  expect(await publish()).toBe("adopted");
  expect(state.artifacts).toEqual([{ id: "artifact-1", body: markdown }]);
  expect(mocked.push).toHaveBeenCalledOnce();
});

it("preserves an intent when preparing it committed but its response was lost", async () => {
  const { state, publish } = makeState();
  state.prepareFailure = true;
  await expect(publish()).rejects.toBeInstanceOf(CheckpointPublicationPendingError);
  expect(state.publication).toMatchObject({ status: "pending", artifact_md: markdown });
  expect(mocked.push).not.toHaveBeenCalled();
  state.prepareFailure = false;
  expect(await publish()).toBe("adopted");
  expect(state.artifacts).toHaveLength(1);
});

it("bounds receipt reads after successful adoption without discarding the durable receipt", async () => {
  vi.useFakeTimers();
  const { state, publish } = makeState();
  const receipt = deferred<Response>();
  state.statusReadWait = receipt.promise;
  const outcome = publish().then(
    () => null,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await outcome).toBeInstanceOf(CheckpointPublicationPendingError);
  expect(state.publication?.status).toBe("adopted");
  expect(state.artifacts).toEqual([{ id: "artifact-1", body: markdown }]);
  receipt.resolve(response({ status: "adopted" }));
  state.statusReadWait = undefined;
  expect(await publish()).toBe("adopted");
  expect(state.artifacts).toHaveLength(1);
  expect(mocked.push).toHaveBeenCalledOnce();
});

it.each([{ workspaceId: "foreign-workspace" }, { jobId: "foreign-job" }, { attemptCount: 3 }])(
  "does not return another execution's adoption receipt for %j",
  async (identity) => {
    const { state, publish } = makeState();
    expect(await publish()).toBe("adopted");
    expect(await publish(identity)).toBe("stale");
    expect(state.artifacts).toHaveLength(1);
    expect(mocked.push).toHaveBeenCalledOnce();
  },
);

it("rejects a changed candidate ref returned by the remote transport", async () => {
  const { state, publish } = makeState();
  mocked.push.mockResolvedValueOnce("wallie/unrelated-ref");
  expect(await publish()).toBe("pending");
  expect(state.events).not.toContain("adopt");
  expect(state.artifacts).toEqual([]);
});

it("does not push or adopt when the claim becomes stale while resolving the repository", async () => {
  const { state, publish } = makeState();
  mocked.repository.mockImplementationOnce(async () => {
    state.current = false;
    return { token: "scoped-token", delivery: state.source };
  });
  expect(await publish()).toBe("stale");
  expect(mocked.push).not.toHaveBeenCalled();
  expect(state.artifacts).toEqual([]);
});

it("rechecks ownership immediately before the external push", async () => {
  const { state, publish } = makeState();
  mocked.push.mockImplementationOnce(async (args: SourceRestoreInput) => {
    state.current = false;
    await args.beforePush?.();
    state.remoteRefs.set(`refs/heads/${args.branch}`, args.headSha);
    return args.branch;
  });
  expect(await publish()).toBe("stale");
  expect(state.remoteRefs.size).toBe(0);
  expect(state.artifacts).toEqual([]);
});

it("fences artifact adoption when cancellation arrives after the remote push", async () => {
  const { state, admin } = makeState({ prepared: true });
  const cancellation = new AbortController();
  mocked.push.mockImplementationOnce(async (args: SourceRestoreInput) => {
    await args.beforePush?.();
    state.remoteRefs.set(`refs/heads/${args.branch}`, args.headSha);
    cancellation.abort(new Error("Session cancelled"));
    return args.branch;
  });
  expect(
    await drainCheckpointPublications(admin, {
      runId: "run",
      limit: 1,
      signal: cancellation.signal,
    }),
  ).toEqual({ adopted: 0, failed: 1 });
  expect(state.remoteRefs.get(retainedRef)).toBe(headSha);
  expect(state.artifacts).toEqual([]);
  expect(state.events).not.toContain("adopt");
});

it.each(["missing", "workspace", "job", "session", "attempt"])(
  "rejects a %s source identity before reading private bytes or pushing",
  async (mismatch) => {
    const { state, admin, publication } = await claimed();
    if (mismatch === "missing") state.source = null;
    else if (mismatch === "workspace") state.source!.workspace_id = "foreign-workspace";
    else if (mismatch === "job") state.source!.job_id = "foreign-job";
    else if (mismatch === "session") state.source!.session_id = "foreign-session";
    else state.source!.attempt_count++;
    await expect(
      adoptCheckpointPublication(admin, publication, new AbortController().signal),
    ).rejects.toThrow("source identity changed");
    expect(mocked.bundle).not.toHaveBeenCalled();
    expect(mocked.repository).not.toHaveBeenCalled();
    expect(mocked.push).not.toHaveBeenCalled();
    expect(state.artifacts).toEqual([]);
  },
);

it("adopts no-code output with its input checkpoint and no invented remote proof or Git operations", async () => {
  const { state, rpc, publish } = makeState({ noCode: true });
  expect(await publish()).toBe("adopted");
  expect(mocked.bundle).not.toHaveBeenCalled();
  expect(mocked.repository).not.toHaveBeenCalled();
  expect(mocked.push).not.toHaveBeenCalled();
  expect(mocked.pr).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledWith("adopt_session_checkpoint_publication", {
    p_run_id: "run",
    p_claim_id: "claim-1",
  });
  expect(state.publication).toMatchObject({
    retained_ref: null,
    remote_verified_ref: null,
    remote_verified_sha: null,
  });
  expect(state.source?.head_sha).toBe(baseSha);
  expect(state.artifacts).toEqual([{ id: "artifact-1", body: markdown }]);
});

it("refuses a fabricated retained ref for no-code output", async () => {
  const { state, admin, publication } = await claimed({ noCode: true });
  await expect(
    adoptCheckpointPublication(
      admin,
      { ...publication, retained_ref: retainedRef },
      new AbortController().signal,
    ),
  ).rejects.toThrow("No-code output must reuse its input checkpoint");
  expect(state.artifacts).toEqual([]);
  expect(mocked.push).not.toHaveBeenCalled();
});

it("keeps the full original artifact body independently of source delivery or PR summaries", async () => {
  const { state, rpc, publish } = makeState();
  const original = `# Full artifact\n${"detailed output\n".repeat(30_000)}END OF ORIGINAL ARTIFACT`;
  expect(await publish({ artifactMarkdown: original })).toBe("adopted");
  expect(rpc).toHaveBeenCalledWith(
    "prepare_session_checkpoint_publication",
    expect.objectContaining({ p_artifact_md: original, p_deadline_at: deadlineAt }),
  );
  expect(state.publication?.artifact_md).toBe(original);
  expect(state.artifacts[0].body).toBe(original);
});

it("rejects an expired claim before private bundle reads, repository minting, or adoption", async () => {
  const { state, admin, publication } = await claimed();
  state.expired = true;
  await expect(
    adoptCheckpointPublication(admin, publication, new AbortController().signal),
  ).rejects.toThrow("claim expired");
  expect(mocked.bundle).not.toHaveBeenCalled();
  expect(mocked.repository).not.toHaveBeenCalled();
  expect(mocked.push).not.toHaveBeenCalled();
  expect(state.artifacts).toEqual([]);
});

it("bounds a leased push even when its transport ignores abort and prevents late adoption", async () => {
  vi.useFakeTimers();
  const { state, admin } = makeState({ prepared: true });
  const pushed = deferred<string>();
  const entered = deferred<void>();
  mocked.push.mockImplementationOnce(async (args: SourceRestoreInput) => {
    await args.beforePush?.();
    entered.resolve();
    return pushed.promise;
  });
  const draining = drainCheckpointPublications(admin, { limit: 1, timeoutMs: 100 });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(100);
  expect(await draining).toEqual({ adopted: 0, failed: 1 });
  state.remoteRefs.set(retainedRef, headSha);
  pushed.resolve(retainedRef.slice("refs/heads/".length));
  await vi.advanceTimersByTimeAsync(0);
  expect(state.artifacts).toEqual([]);
  expect(state.events).not.toContain("adopt");
});

it("bounds a failed claim release without waiting indefinitely for its transport", async () => {
  vi.useFakeTimers();
  const { state, admin } = makeState({ prepared: true });
  const release = deferred<Response>();
  state.releaseWait = release.promise;
  mocked.push.mockRejectedValueOnce(new Error("Git unavailable"));
  let completed = false;
  const draining = drainCheckpointPublications(admin, { limit: 1, timeoutMs: 100 }).then(
    (result) => {
      completed = true;
      return result;
    },
  );
  await vi.advanceTimersByTimeAsync(100);
  const completedWithinLease = completed;
  release.resolve(response(null, "release response lost"));
  expect(await draining).toEqual({ adopted: 0, failed: 1 });
  expect(completedWithinLease).toBe(true);
  expect(state.artifacts).toEqual([]);
});

it("does not replace immutable original output when releasing a failed publication also fails", async () => {
  const { state, publish } = makeState();
  state.releaseFailure = true;
  mocked.push.mockRejectedValueOnce(new Error("Git unavailable"));
  expect(await publish()).toBe("pending");
  expect(state.publication?.status).toBe("claimed");
  await expect(
    publish({ artifactMarkdown: "Replacement result", expectedArtifactVersion: 99 }),
  ).rejects.toBeInstanceOf(CheckpointPublicationPendingError);
  expect(state.publication).toMatchObject({
    artifact_md: markdown,
    expected_artifact_version: 4,
    publication_attempt_count: 1,
  });
  expect(state.artifacts).toEqual([]);
  expect(mocked.push).toHaveBeenCalledOnce();
});
