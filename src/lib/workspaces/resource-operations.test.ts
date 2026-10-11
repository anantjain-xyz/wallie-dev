import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateSessionSandboxInput } from "@/lib/sandbox/types";

const mocked = vi.hoisted(() => ({ createSessionSandbox: vi.fn() }));
vi.mock("@/lib/sandbox", () => ({ createSessionSandbox: mocked.createSessionSandbox }));

import { createWorkspaceSessionSandbox, uploadWorkspaceObject } from "./resource-operations";

const input = {
  agentProvider: "codex",
  baseBranch: "main",
  branch: "wallie/test",
  implementation: "fake",
  onSandboxCreated: async () => undefined,
  installationToken: "fixture-token",
  repoFullName: "test/repo",
  sessionId: "session-1",
  workspaceId: "workspace-1",
} satisfies CreateSessionSandboxInput;

function client(
  options: { deleting?: boolean; recordFailure?: boolean; reserveFailure?: boolean } = {},
) {
  const operations: Array<{ id: string; resourceId: string | null; settled: boolean }> = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "begin_workspace_resource_operation") {
      if (options.reserveFailure)
        return { data: null, error: new Error("Workspace deletion is in progress.") };
      operations.push({ id: "operation-1", resourceId: null, settled: false });
      return { data: "operation-1", error: null };
    }
    if (name === "record_workspace_resource_operation") {
      if (options.recordFailure) return { data: null, error: new Error("Database unavailable") };
      operations[0]!.resourceId = args.p_resource_id as string;
      return { data: !options.deleting, error: null };
    }
    if (name === "settle_workspace_resource_operation") {
      if (args.p_transferred && !options.deleting) operations.splice(0);
      else operations[0]!.settled = true;
      return { data: null, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  return { admin: { rpc } as never, operations, rpc };
}

describe("workspace resource admission", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("persists the sandbox identity before the run ownership callback and transfers only after setup", async () => {
    const state = client();
    const owned: string[] = [];
    const onSandboxCreated = vi.fn(async ({ sandboxId }: { sandboxId: string }) => {
      expect(state.operations).toEqual([
        { id: "operation-1", resourceId: "sandbox-1", settled: false },
      ]);
      owned.push(sandboxId);
    });
    mocked.createSessionSandbox.mockImplementationOnce(
      async (request: CreateSessionSandboxInput) => {
        await request.onSandboxCreated?.({ provider: "fake", sandboxId: "sandbox-1" });
        return { id: "sandbox-1" };
      },
    );
    expect(
      await createWorkspaceSessionSandbox(state.admin, { ...input, onSandboxCreated }),
    ).toEqual({ id: "sandbox-1" });
    expect(owned).toEqual(["sandbox-1"]);
    expect(state.operations).toEqual([]);
  });

  it("rejects remote creation when deletion already fenced admission", async () => {
    const state = client({ reserveFailure: true });
    await expect(createWorkspaceSessionSandbox(state.admin, input)).rejects.toThrow(
      "Workspace deletion is in progress.",
    );
    expect(state.operations).toEqual([]);
    expect(mocked.createSessionSandbox).not.toHaveBeenCalled();
  });

  it("retains a late sandbox ID for deletion cleanup without granting run ownership", async () => {
    const state = client({ deleting: true });
    const owner = vi.fn();
    mocked.createSessionSandbox.mockImplementationOnce(
      async (request: CreateSessionSandboxInput) => {
        await request.onSandboxCreated?.({ provider: "fake", sandboxId: "late-sandbox" });
      },
    );
    await expect(
      createWorkspaceSessionSandbox(state.admin, { ...input, onSandboxCreated: owner }),
    ).rejects.toThrow("Workspace deletion is in progress.");
    expect(state.operations).toEqual([
      { id: "operation-1", resourceId: "late-sandbox", settled: true },
    ]);
    expect(owner).not.toHaveBeenCalled();
  });

  it("leaves an unknown acquisition pending when saving its ID fails", async () => {
    const state = client({ recordFailure: true });
    mocked.createSessionSandbox.mockImplementationOnce(
      async (request: CreateSessionSandboxInput) => {
        await request.onSandboxCreated?.({ provider: "fake", sandboxId: "unrecorded-sandbox" });
      },
    );
    await expect(createWorkspaceSessionSandbox(state.admin, input)).rejects.toThrow(
      "Database unavailable",
    );
    expect(state.operations).toEqual([{ id: "operation-1", resourceId: null, settled: false }]);
  });

  it("retains cleanup ownership when a canceled run refuses its sandbox", async () => {
    const state = client();
    mocked.createSessionSandbox.mockImplementationOnce(
      async (request: CreateSessionSandboxInput) => {
        await request.onSandboxCreated?.({ provider: "fake", sandboxId: "canceled-sandbox" });
      },
    );
    await expect(
      createWorkspaceSessionSandbox(state.admin, {
        ...input,
        onSandboxCreated: async () => {
          throw new Error("Canceled attempt");
        },
      }),
    ).rejects.toThrow("Canceled attempt");
    expect(state.operations).toEqual([
      { id: "operation-1", resourceId: "canceled-sandbox", settled: true },
    ]);
  });

  it("reserves the exact upload path and keeps ambiguous upload failures recoverable", async () => {
    const state = client();
    const upload = vi.fn().mockResolvedValue({ error: { message: "Lost upload acknowledgement" } });
    const admin = { rpc: state.rpc, storage: { from: vi.fn(() => ({ upload })) } };
    const result = await uploadWorkspaceObject(admin as never, {
      bucket: "session-attachments",
      bytes: Buffer.from("image"),
      contentType: "image/png",
      path: "workspace-1/attachment.png",
      workspaceId: "workspace-1",
    });
    expect(result.error).toEqual({ message: "Lost upload acknowledgement" });
    expect(state.rpc).toHaveBeenCalledWith(
      "begin_workspace_resource_operation",
      expect.objectContaining({
        p_kind: "upload",
        p_storage_bucket: "session-attachments",
        p_resource_id: "workspace-1/attachment.png",
        p_workspace_id: "workspace-1",
      }),
    );
    expect(state.operations).toEqual([{ id: "operation-1", resourceId: null, settled: false }]);
  });
});
