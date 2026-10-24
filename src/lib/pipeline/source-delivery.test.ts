import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({ upload: vi.fn(), push: vi.fn(), pr: vi.fn(), token: vi.fn() }));
vi.mock("@/lib/workspaces/resource-operations", () => ({ uploadWorkspaceObject: mocked.upload }));
vi.mock("@/features/github/sandbox-token", () => ({ mintSandboxRepositoryToken: mocked.token }));
vi.mock("./source-delivery-sandbox", () => ({ restoreAndPushSourceInSandbox: mocked.push }));
vi.mock("./source-pull-request", () => ({ ensureSourcePullRequest: mocked.pr }));

import {
  drainSourceDeliveries,
  prepareSourceDelivery,
  type SourceDelivery,
} from "./source-delivery";

const bytes = Buffer.from("private synthetic source");
const checkpoint = {
  kind: "bundle" as const,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  bytes,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
function query<T>(value: T) {
  return Object.assign(Promise.resolve(value), {
    abortSignal: vi.fn(() => Promise.resolve(value)),
  });
}
function makeAdmin(
  input: { fallback?: boolean; download?: Promise<unknown>; prepareError?: boolean } = {},
) {
  const row = {
    run_id: "run",
    workspace_id: "workspace",
    session_id: "session",
    job_id: "job",
    attempt_count: 1,
    repository_id: "repository",
    installation_id: 12,
    repository_full_name: "acme/app",
    branch_name: "wallie/attempt1",
    base_branch: "trunk",
    base_sha: checkpoint.baseSha,
    head_sha: checkpoint.headSha,
    bundle_sha256: checkpoint.sha256,
    bundle_base64: input.fallback ? bytes.toString("base64") : null,
    checkpoint_path: input.fallback ? null : "workspace/run.bundle",
    title: "Build",
    body: "Done",
    status: "pending",
    delivery_attempt_count: 0,
    claim_id: null,
    lease_expires_at: null,
    next_attempt_at: "2026-10-01T00:00:00Z",
    created_at: "2026-10-01T00:00:00Z",
    delivered_at: null,
    last_error_code: null,
  } as SourceDelivery;
  const rpc = vi.fn((name: string, args?: Record<string, unknown>) => {
    if (name === "prepare_session_source_delivery")
      return query({
        data: !input.prepareError,
        error: input.prepareError ? { message: "payload private synthetic source" } : null,
      });
    if (name === "claim_session_source_delivery") {
      if (row.status !== "pending") return query({ data: null, error: null });
      row.status = "claimed";
      row.claim_id = `lease-${++row.delivery_attempt_count}`;
      return query({ data: row.claim_id, error: null });
    }
    if (name === "assert_session_source_delivery_claim")
      return query({
        data: row.status === "claimed" && row.claim_id === args?.p_claim_id,
        error: null,
      });
    if (name === "finish_session_source_delivery") {
      if (row.claim_id !== args?.p_claim_id) return query({ data: false, error: null });
      row.status = args?.p_delivered ? "delivered" : "pending";
      if (args?.p_delivered) row.bundle_base64 = null;
      row.claim_id = null;
      return query({ data: true, error: null });
    }
    if (name === "record_session_pull_request") return query({ data: null, error: null });
    throw new Error(`Unexpected RPC ${name}`);
  });
  const download = vi.fn(
    () => input.download ?? Promise.resolve({ data: new Blob([bytes]), error: null }),
  );
  const single = vi.fn(() => query({ data: { ...row }, error: null }));
  const repository = {
    full_name: "acme/app",
    github_installation_id: "installation",
    repo_id: 777,
    is_archived: false,
  };
  const installation = { installation_id: 12 };
  const admin = {
    rpc,
    from: vi.fn((table: string) => {
      const chain = {
        select: () => chain,
        eq: vi.fn(() => chain),
        abortSignal: () => chain,
        single,
        maybeSingle: () =>
          query({ data: table === "github_repositories" ? repository : installation, error: null }),
      };
      return chain;
    }),
    storage: { from: vi.fn(() => ({ download })) },
  } as unknown as SupabaseClient<Database>;
  return { admin, rpc, row, download, repository, installation };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocked.upload.mockResolvedValue({ error: null });
  mocked.push.mockResolvedValue("wallie/attempt1");
  mocked.pr.mockResolvedValue(undefined);
  mocked.token.mockResolvedValue("scoped-token");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async () => Response.json({ id: 777, full_name: "acme/app" })),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("records Storage durability before the outbox and uses a deterministic tenant key", async () => {
  const { admin, rpc } = makeAdmin();
  const durable = vi.fn();
  expect(
    await prepareSourceDelivery({
      admin,
      baseBranch: "trunk",
      body: "done",
      checkpoint,
      onDurable: durable,
      repositoryId: "repository",
      runId: "run",
      title: "Build",
      workspaceId: "workspace",
    }),
  ).toBe(true);
  expect(mocked.upload).toHaveBeenCalledWith(
    admin,
    expect.objectContaining({
      path: "workspace/run.bundle",
      bucket: "session-source-checkpoints",
      bytes,
    }),
  );
  expect(durable.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0]);
  expect(rpc).toHaveBeenCalledWith(
    "prepare_session_source_delivery",
    expect.objectContaining({ p_checkpoint_path: "workspace/run.bundle", p_bundle_base64: "" }),
  );
});

it("uses the bounded private DB fallback during a Storage outage and restores it on retry", async () => {
  mocked.upload.mockRejectedValue(new Error("Storage offline"));
  const { admin, rpc, row, download } = makeAdmin({ fallback: true });
  const durable = vi.fn();
  await prepareSourceDelivery({
    admin,
    baseBranch: "trunk",
    body: "done",
    checkpoint,
    onDurable: durable,
    repositoryId: "repository",
    runId: "run",
    title: "Build",
    workspaceId: "workspace",
  });
  expect(rpc).toHaveBeenCalledWith(
    "prepare_session_source_delivery",
    expect.objectContaining({ p_checkpoint_path: "", p_bundle_base64: bytes.toString("base64") }),
  );
  expect(durable).toHaveBeenCalledOnce();
  mocked.push.mockRejectedValueOnce(new Error("Git unavailable"));
  expect(await drainSourceDeliveries(admin, { limit: 1 })).toEqual({ delivered: 0, failed: 1 });
  expect(row.bundle_base64).toBe(bytes.toString("base64"));
  expect(row.status).toBe("pending");
  expect(await drainSourceDeliveries(admin, { limit: 1 })).toEqual({ delivered: 1, failed: 0 });
  expect(download).not.toHaveBeenCalled();
  expect(mocked.push).toHaveBeenLastCalledWith(
    expect.objectContaining({ bytes, remoteUrl: "https://github.com/acme/app.git" }),
    expect.objectContaining({ runId: "run", workspaceId: "workspace" }),
  );
  expect(row.bundle_base64).toBeNull();
  expect(row.status).toBe("delivered");
});

it("uses the recovered Git branch for both the pull request and its recorded identity", async () => {
  const branch = `wallie/recovery/${"c".repeat(64)}`;
  const { admin, rpc } = makeAdmin({ fallback: true });
  const { ensureSourcePullRequest } =
    await vi.importActual<typeof import("./source-pull-request")>("./source-pull-request");
  mocked.push.mockResolvedValue(branch);
  mocked.pr.mockImplementation(ensureSourcePullRequest);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ id: 777, full_name: "acme/app" }))
    .mockResolvedValueOnce(Response.json([]))
    .mockResolvedValueOnce(
      Response.json({
        number: 42,
        html_url: "https://github.com/acme/app/pull/42",
        draft: false,
        state: "open",
        merged_at: null,
        updated_at: "2026-10-01T00:00:00Z",
        head: { ref: branch, sha: checkpoint.headSha, repo: { full_name: "acme/app" } },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  expect(await drainSourceDeliveries(admin, { limit: 1 })).toEqual({ delivered: 1, failed: 0 });
  expect(mocked.pr).toHaveBeenCalledWith(
    expect.objectContaining({ delivery: expect.objectContaining({ branch_name: branch }) }),
  );
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ head: branch });
  expect(rpc).toHaveBeenCalledWith(
    "record_session_pull_request",
    expect.objectContaining({ target_branch_name: branch, source_pull_request_number: 42 }),
  );
});

it("does not report durability when both storage and database writes fail or expose source in its error", async () => {
  mocked.upload.mockRejectedValue(new Error("Storage offline"));
  const { admin } = makeAdmin({ prepareError: true });
  const durable = vi.fn();
  await expect(
    prepareSourceDelivery({
      admin,
      baseBranch: "trunk",
      body: "done",
      checkpoint,
      onDurable: durable,
      repositoryId: "repository",
      runId: "run",
      title: "Build",
      workspaceId: "workspace",
    }),
  ).rejects.toThrow("No artifact was published");
  expect(durable).not.toHaveBeenCalled();
});

it("preserves an uploaded checkpoint when a crash or DB failure prevents outbox creation", async () => {
  const { admin } = makeAdmin({ prepareError: true });
  const durable = vi.fn();
  await expect(
    prepareSourceDelivery({
      admin,
      baseBranch: "trunk",
      body: "done",
      checkpoint,
      onDurable: durable,
      repositoryId: "repository",
      runId: "run",
      title: "Build",
      workspaceId: "workspace",
    }),
  ).rejects.toThrow("checkpoint could not be recorded");
  expect(durable).toHaveBeenCalledOnce();
  expect(mocked.upload).toHaveBeenCalledWith(
    admin,
    expect.objectContaining({ path: "workspace/run.bundle" }),
  );
});

it("retries PR or metadata failure without discarding the durable checkpoint", async () => {
  const { admin, row } = makeAdmin();
  mocked.pr.mockRejectedValueOnce(new Error("PR failed"));
  expect(await drainSourceDeliveries(admin, { limit: 1 })).toEqual({ delivered: 0, failed: 1 });
  expect(row.checkpoint_path).toBe("workspace/run.bundle");
  expect(await drainSourceDeliveries(admin, { limit: 1 })).toEqual({ delivered: 1, failed: 0 });
  expect(mocked.push).toHaveBeenCalledTimes(2);
  expect(mocked.pr).toHaveBeenCalledTimes(2);
});

it("bounds a hung download and fences its late continuation before GitHub writes", async () => {
  let resolve!: (value: unknown) => void;
  const { admin, row } = makeAdmin({
    download: new Promise((r) => {
      resolve = r;
    }),
  });
  expect(await drainSourceDeliveries(admin, { limit: 1, timeoutMs: 10 })).toEqual({
    delivered: 0,
    failed: 1,
  });
  expect(row.status).toBe("claimed");
  resolve({ data: new Blob([bytes]), error: null });
  await new Promise((r) => setTimeout(r, 0));
  expect(mocked.token).not.toHaveBeenCalled();
  expect(mocked.push).not.toHaveBeenCalled();
});

it("reloads renamed repository and replacement installation identity on every retry", async () => {
  const { admin, row, repository, installation } = makeAdmin();
  mocked.push.mockRejectedValueOnce(new Error("temporary failure"));
  expect(await drainSourceDeliveries(admin, { limit: 1 })).toEqual({ delivered: 0, failed: 1 });
  repository.full_name = "new-owner/renamed";
  repository.github_installation_id = "new-installation";
  installation.installation_id = 99;
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ id: 777, full_name: "new-owner/renamed" }),
  );
  expect(await drainSourceDeliveries(admin, { limit: 1 })).toEqual({ delivered: 1, failed: 0 });
  expect(mocked.token).toHaveBeenLastCalledWith({
    installationId: 99,
    repositoryFullName: "new-owner/renamed",
    repositoryId: 777,
    purpose: "execution",
  });
  expect(mocked.push).toHaveBeenLastCalledWith(
    expect.objectContaining({ remoteUrl: "https://github.com/new-owner/renamed.git" }),
    expect.objectContaining({ runId: "run", workspaceId: "workspace" }),
  );
  expect(mocked.pr).toHaveBeenLastCalledWith(
    expect.objectContaining({
      delivery: expect.objectContaining({
        repository_full_name: "new-owner/renamed",
        installation_id: 99,
      }),
    }),
  );
  expect(row.repository_full_name).toBe("acme/app");
});

it("refuses a reused repository name whose GitHub numeric identity has changed", async () => {
  const { admin, row } = makeAdmin({ fallback: true });
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ id: 888, full_name: "acme/app" }));
  expect(await drainSourceDeliveries(admin, { limit: 1 })).toEqual({ delivered: 0, failed: 1 });
  expect(mocked.push).not.toHaveBeenCalled();
  expect(mocked.pr).not.toHaveBeenCalled();
  expect(row.bundle_base64).toBe(bytes.toString("base64"));
  expect(row.status).toBe("pending");
});
