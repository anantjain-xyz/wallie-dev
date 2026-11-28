import { expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { restoreRetryInput, saveRetryCheckpoint } from "./retry-checkpoint";

const source = vi.hoisted(() => ({
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  bundleSha256: "c".repeat(64),
}));

vi.mock("./source-checkpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./source-checkpoint")>()),
  readSourceBase: vi.fn().mockResolvedValue(source.headSha),
  captureCommittedSourceCheckpoint: vi.fn().mockResolvedValue({
    kind: "bundle",
    baseSha: source.baseSha,
    headSha: source.headSha,
    bytes: Buffer.from("source"),
    sha256: source.bundleSha256,
  }),
}));

const retryContext = {
  attemptCount: 1,
  baseSha: source.baseSha,
  jobId: "job-1",
  runId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "workspace-1",
  sensitiveValues: async () => [],
};

it.each(["PGRST202", "42501"])(
  "rejects checkpoint lookup error %s without reserving or uploading source",
  async (code) => {
    const from = vi.fn();
    const rpc = vi.fn((name: string) => {
      if (name !== "get_session_retry_checkpoint") throw new Error(`Unexpected RPC ${name}`);
      return {
        abortSignal: async () => ({
          data: null,
          error: { code, message: "Checkpoint lookup failed" },
        }),
      };
    });
    const context = {
      ...retryContext,
      admin: { rpc, storage: { from } } as never,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      sandbox: new FakeSandbox(),
      signal: new AbortController().signal,
    };

    for (const operation of [restoreRetryInput, saveRetryCheckpoint]) {
      await expect(operation(context)).rejects.toThrow("Could not read the Retry checkpoint.");
    }

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(from).not.toHaveBeenCalled();
  },
);

it("continues without restoring source after a successful empty checkpoint lookup", async () => {
  const from = vi.fn();
  const abortSignal = vi.fn().mockResolvedValue({ data: [], error: null });
  const rpc = vi.fn(() => ({ abortSignal }));
  const signal = new AbortController().signal;

  await expect(
    restoreRetryInput({
      ...retryContext,
      admin: { rpc, storage: { from } } as never,
      sandbox: new FakeSandbox(),
      signal,
    }),
  ).resolves.toBe(false);

  expect(rpc).toHaveBeenCalledExactlyOnceWith("get_session_retry_checkpoint", {
    p_job_id: retryContext.jobId,
    p_attempt_count: retryContext.attemptCount,
    p_run_id: retryContext.runId,
  });
  expect(abortSignal).toHaveBeenCalledExactlyOnceWith(signal);
  expect(from).not.toHaveBeenCalled();
});

it.each(["saved", "canceled", "rejected", "lost response"] as const)(
  "keeps the timeout upload owned by its durable reservation when the save is %s",
  async (outcome) => {
    const controller = new AbortController();
    const upload = vi.fn(async (path: string) => {
      if (outcome === "canceled") controller.abort(new Error("Canceled attempt"));
      return { data: { id: "object-1", path, fullPath: path }, error: null };
    });
    const remove = vi.fn();
    const rpc = vi.fn((name: string) => {
      if (name === "get_session_retry_checkpoint") {
        return { abortSignal: async () => ({ data: [], error: null }) };
      }
      if (name === "begin_workspace_resource_operation") {
        return {
          abortSignal: async () => ({ data: "reservation-1", error: null }),
        };
      }
      if (name === "save_session_retry_checkpoint") {
        return {
          abortSignal: async () => ({
            data: outcome === "lost response" ? null : outcome === "saved",
            error: outcome === "lost response" ? new Error("Database unavailable") : null,
          }),
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const admin = { rpc, storage: { from: vi.fn(() => ({ remove, upload })) } };
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const save = saveRetryCheckpoint({
      ...retryContext,
      admin: admin as never,
      deadlineAt,
      sandbox: new FakeSandbox(),
      signal: controller.signal,
    });

    if (outcome === "canceled") {
      await expect(save).rejects.toThrow("Canceled attempt");
    } else if (outcome === "lost response") {
      await expect(save).rejects.toThrow("Could not record the Retry checkpoint.");
    } else {
      await expect(save).resolves.toBe(outcome === "saved");
    }

    const path = upload.mock.calls[0]?.[0];
    expect(path).toMatch(
      /^workspace-1\/11111111-1111-4111-8111-111111111111-retry-1-[a-f0-9-]{36}\.bundle$/,
    );
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "get_session_retry_checkpoint",
      "begin_workspace_resource_operation",
      ...(outcome === "canceled" ? [] : ["save_session_retry_checkpoint"]),
    ]);
    if (outcome !== "canceled") {
      expect(rpc).toHaveBeenCalledWith("save_session_retry_checkpoint", {
        p_attempt_count: retryContext.attemptCount,
        p_bundle_sha256: source.bundleSha256,
        p_checkpoint_path: path,
        p_deadline_at: deadlineAt,
        p_head_sha: source.headSha,
        p_input_sha: source.baseSha,
        p_job_id: retryContext.jobId,
        p_run_id: retryContext.runId,
        p_upload_operation_id: "reservation-1",
      });
    }
    expect(remove).not.toHaveBeenCalled();
  },
);
