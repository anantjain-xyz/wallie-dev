import { expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { saveRetryCheckpoint } from "./retry-checkpoint";

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

it.each(["canceled", "rejected", "lost response"] as const)(
  "leaves retry upload cleanup to its durable reservation when saving is %s",
  async (outcome) => {
    const controller = new AbortController();
    const upload = vi.fn(async (path: string) => {
      if (outcome === "canceled") controller.abort(new Error("Canceled attempt"));
      return { data: { id: "object-1", path, fullPath: path }, error: null };
    });
    const remove = vi.fn();
    const rpc = vi.fn((name: string) => {
      if (name === "begin_workspace_resource_operation") {
        return {
          abortSignal: async () => ({ data: "reservation-1", error: null }),
        };
      }
      if (name === "save_session_retry_checkpoint") {
        return {
          abortSignal: async () => ({
            data: outcome === "rejected" ? false : null,
            error: outcome === "lost response" ? new Error("Database unavailable") : null,
          }),
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const admin = { rpc, storage: { from: vi.fn(() => ({ remove, upload })) } };
    const save = saveRetryCheckpoint({
      admin: admin as never,
      attemptCount: 1,
      baseSha: source.baseSha,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      jobId: "job-1",
      runId: "11111111-1111-4111-8111-111111111111",
      sandbox: new FakeSandbox(),
      sensitiveValues: async () => [],
      signal: controller.signal,
      workspaceId: "workspace-1",
    });

    if (outcome === "canceled") {
      await expect(save).rejects.toThrow("Canceled attempt");
    } else if (outcome === "rejected") {
      await expect(save).resolves.toBe(false);
    } else {
      await expect(save).rejects.toThrow("Could not record the Retry checkpoint.");
    }

    const path = upload.mock.calls[0]?.[0];
    expect(path).toMatch(
      /^workspace-1\/11111111-1111-4111-8111-111111111111-retry-1-[a-f0-9-]{36}\.bundle$/,
    );
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "begin_workspace_resource_operation",
      ...(outcome === "canceled" ? [] : ["save_session_retry_checkpoint"]),
    ]);
    if (outcome !== "canceled") {
      expect(rpc).toHaveBeenCalledWith(
        "save_session_retry_checkpoint",
        expect.objectContaining({
          p_checkpoint_path: path,
          p_upload_operation_id: "reservation-1",
        }),
      );
    }
    expect(remove).not.toHaveBeenCalled();
  },
);
