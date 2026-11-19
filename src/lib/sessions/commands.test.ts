import { beforeEach, describe, expect, it, vi } from "vitest";

import { cancelSessionCommand } from "./commands";

const mocked = vi.hoisted(() => ({
  cleanupSessionWorkReceipt: vi.fn(),
}));

vi.mock("@/lib/pipeline/cancel", () => ({
  cleanupSessionWorkReceipt: mocked.cleanupSessionWorkReceipt,
}));

function buildCancelClient() {
  const single = vi.fn();
  const rpc = vi.fn(() => ({ single }));
  const admin = { rpc } as unknown as Parameters<typeof cancelSessionCommand>[0]["admin"];
  return { admin, rpc, single };
}

describe("keyed session cancellation", () => {
  const input = {
    command: {
      actorMemberId: "actor",
      expectedRunId: "expected-run",
      factoryId: "factory",
      requestId: "request",
    },
    sessionId: "session",
    workspaceId: "workspace",
  };
  const receipt = { job_ids: ["original-job"], run_ids: ["expected-run"] };

  beforeEach(() => {
    vi.resetAllMocks();
    mocked.cleanupSessionWorkReceipt.mockResolvedValue({
      canceledJobIds: receipt.job_ids,
      canceledRunIds: receipt.run_ids,
      stoppedSandboxIds: [],
    });
  });

  it("submits the scoped intent and cleans up only the stored IDs on replay", async () => {
    const { admin, rpc, single } = buildCancelClient();
    single
      .mockResolvedValueOnce({ data: { ...receipt, replayed: false }, error: null })
      .mockResolvedValueOnce({ data: { ...receipt, replayed: true }, error: null });

    await expect(cancelSessionCommand({ admin, ...input })).resolves.toMatchObject({
      canceledRunIds: ["expected-run"],
      replayed: false,
    });
    await expect(cancelSessionCommand({ admin, ...input })).resolves.toMatchObject({
      canceledRunIds: ["expected-run"],
      replayed: true,
    });

    expect(rpc).toHaveBeenCalledWith("cancel_session_command_once", {
      actor_member_id: "actor",
      expected_run_id: "expected-run",
      target_factory_id: "factory",
      target_request_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      target_request_id: "request",
      target_session_id: "session",
      target_workspace_id: "workspace",
    });
    expect(rpc.mock.calls.at(0)).toEqual(rpc.mock.calls.at(1));
    expect(mocked.cleanupSessionWorkReceipt).toHaveBeenCalledTimes(2);
    expect(mocked.cleanupSessionWorkReceipt).toHaveBeenLastCalledWith(admin, {
      receipt: { ...receipt, replayed: true },
      workspaceId: "workspace",
    });
  });

  it("returns a stale-generation failure without cleaning up any runs", async () => {
    const { admin, single } = buildCancelClient();
    const stale = { code: "P0003", message: "Session generation changed." };
    single.mockResolvedValue({ data: null, error: stale });

    await expect(cancelSessionCommand({ admin, ...input })).rejects.toEqual(stale);
    expect(mocked.cleanupSessionWorkReceipt).not.toHaveBeenCalled();
  });
});
