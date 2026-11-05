import { beforeEach, expect, it, vi } from "vitest";
import type { Tables } from "@/lib/supabase/database.types";

const mocked = vi.hoisted(() => ({ git: vi.fn(), repository: vi.fn(), sandbox: vi.fn() }));
vi.mock("./checkpoint-cleanup-git", async (original) => ({
  ...(await original<typeof import("./checkpoint-cleanup-git")>()),
  deleteRetainedCheckpointRefWithWorkspace: mocked.git,
}));
vi.mock("./source-delivery", () => ({ resolveSourceDeliveryRepository: mocked.repository }));
vi.mock("./source-delivery-sandbox", () => ({ withSourceGitSandbox: mocked.sandbox }));

import { cleanRetainedCheckpoint, drainCheckpointCleanup } from "./checkpoint-cleanup";
import { RetainedCheckpointRefConflictError } from "./checkpoint-cleanup-git";

const runId = "79900000-0000-4000-8000-000000000001";
const sha = "a".repeat(40);
const ref = `refs/heads/wallie/checkpoints/${runId}/${sha}`;
const cleanup = {
  run_id: runId,
  workspace_id: "79900000-0000-4000-8000-000000000002",
  session_id: "79900000-0000-4000-8000-000000000003",
  repository_id: "79900000-0000-4000-8000-000000000004",
  repository_full_name: "example/fixture",
  github_repository_id: 777,
  expected_sha: sha,
  retained_ref: ref,
  claim_id: "79900000-0000-4000-8000-000000000005",
} as Tables<"session_checkpoint_cleanup">;
const response = (data: unknown, error: unknown = null) => {
  const promise = Promise.resolve({ data, error });
  return Object.assign(promise, { abortSignal: () => promise });
};
function fixture() {
  const state = { ownership: true, finishError: false, claims: 0 };
  const rpc = vi.fn((name: string) => {
    if (name === "claim_session_checkpoint_cleanup")
      return response(state.claims++ === 0 ? cleanup.claim_id : null);
    if (name === "assert_session_checkpoint_cleanup_claim") return response(state.ownership);
    if (name === "finish_session_checkpoint_cleanup")
      return response(!state.finishError, state.finishError ? {} : null);
    return response(true);
  });
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    abortSignal: vi.fn(() => query),
    single: vi.fn(async () => ({ data: cleanup, error: null })),
  };
  const admin = { rpc, from: vi.fn(() => query) };
  return { state, rpc, admin: admin as never };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.repository.mockResolvedValue({
    token: "synthetic-retirement-token",
    repositoryNumericId: 777,
    delivery: cleanup,
  });
  mocked.sandbox.mockImplementation(async (_signal, _context, execute) => execute({}));
  mocked.git.mockImplementation(async (input) => {
    await input.beforeDelete();
    return { ref, absent: true };
  });
});

it("rechecks the durable claim before exact deletion and records only absence proof", async () => {
  const f = fixture();
  await cleanRetainedCheckpoint(f.admin, cleanup, new AbortController().signal);
  expect(mocked.git).toHaveBeenCalledWith(expect.objectContaining({ runId, headSha: sha }), {});
  expect(f.rpc).toHaveBeenLastCalledWith("finish_session_checkpoint_cleanup", {
    p_run_id: runId,
    p_claim_id: cleanup.claim_id,
    p_remote_absent: true,
  });
  expect(
    f.rpc.mock.calls.filter(([name]) => name === "assert_session_checkpoint_cleanup_claim"),
  ).toHaveLength(3);
});

it("keeps a lost receipt retryable against the same already-absent ref", async () => {
  const f = fixture();
  f.state.finishError = true;
  await expect(
    cleanRetainedCheckpoint(f.admin, cleanup, new AbortController().signal),
  ).rejects.toThrow("receipt");
  f.state.finishError = false;
  await cleanRetainedCheckpoint(f.admin, cleanup, new AbortController().signal);
  expect(mocked.git).toHaveBeenCalledTimes(2);
  expect(
    f.rpc.mock.calls.filter(([name]) => name === "finish_session_checkpoint_cleanup"),
  ).toHaveLength(2);
});

it("refuses a changed repository identity before provisioning", async () => {
  const f = fixture();
  mocked.repository.mockResolvedValue({ repositoryNumericId: 888, delivery: cleanup });
  await expect(
    cleanRetainedCheckpoint(f.admin, cleanup, new AbortController().signal),
  ).rejects.toThrow("identity changed");
  expect(mocked.sandbox).not.toHaveBeenCalled();
});

it("cannot delete after ownership is lost during provisioning", async () => {
  const f = fixture();
  mocked.sandbox.mockImplementation(async (_signal, _context, execute) => {
    f.state.ownership = false;
    return execute({});
  });
  await expect(
    cleanRetainedCheckpoint(f.admin, cleanup, new AbortController().signal),
  ).rejects.toThrow("claim expired");
  expect(f.rpc.mock.calls.some(([name]) => name === "finish_session_checkpoint_cleanup")).toBe(
    false,
  );
});

it("records external ref conflicts with a fixed code while preserving the remote", async () => {
  const f = fixture();
  mocked.git.mockRejectedValue(new RetainedCheckpointRefConflictError());
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(await drainCheckpointCleanup(f.admin, { limit: 1 })).toEqual({ retired: 0, failed: 1 });
  expect(f.rpc).toHaveBeenLastCalledWith("fail_session_checkpoint_cleanup", {
    p_run_id: runId,
    p_claim_id: cleanup.claim_id,
    p_error_code: "remote_ref_conflict",
  });
  warn.mockRestore();
});

it("bounds a transport that ignores claim cancellation", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const stuck = Object.assign(new Promise(() => undefined), {
    abortSignal() {
      return this;
    },
  });
  const admin = { rpc: vi.fn(() => stuck) };
  expect(await drainCheckpointCleanup(admin as never, { limit: 1, timeoutMs: 5 })).toEqual({
    retired: 0,
    failed: 1,
  });
  expect(mocked.git).not.toHaveBeenCalled();
  warn.mockRestore();
});
