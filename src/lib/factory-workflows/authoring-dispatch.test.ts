import { expect, it, vi } from "vitest";

import { drainAuthoredFactoryWorkflowEntry } from "./authoring-dispatch";
import { executeFactoryWorkflowOccurrence } from "./execute";

vi.mock("./execute", () => ({ executeFactoryWorkflowOccurrence: vi.fn() }));

const id = (slot: number) => `65500000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const entry = {
  leaseExpiresAt: new Date(Date.now() + 75_000).toISOString(),
  rootSessionId: id(1),
  workspaceId: id(2),
  factoryId: id(3),
  inputRunId: id(4),
  workflowDigest: "a".repeat(64),
  occurrenceId: id(5),
  nodeId: "source.checkpoint",
  generation: 1,
  ownershipToken: id(6),
};

function fixture({
  idle = false,
  lostReply = false,
  wrongLease = false,
}: { idle?: boolean; lostReply?: boolean; wrongLease?: boolean } = {}) {
  let claimCount = 0;
  const rpc = vi.fn((name: string, params: Record<string, unknown>) => ({
    abortSignal: vi.fn(async () => {
      if (name === "claim_factory_workflow_authoring_dispatch") {
        claimCount += 1;
        if (lostReply && claimCount === 1) throw new Error("Lost claim response.");
        return {
          data: idle ? null : { ...entry, leaseId: wrongLease ? id(10) : params.p_lease_id },
          error: null,
        };
      }
      if (name === "finish_factory_workflow_authoring_dispatch")
        return { data: "complete", error: null };
      throw new Error(`Unexpected RPC ${name}`);
    }),
  }));
  return { rpc, admin: { rpc } as never };
}

it("replays an ambiguous claim, then executes and settles the exact frozen entry once", async () => {
  vi.clearAllMocks();
  const { rpc, admin } = fixture({ lostReply: true });

  await drainAuthoredFactoryWorkflowEntry(admin);

  const { p_lease_id: leaseId } = rpc.mock.calls[0][1];
  expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  expect(executeFactoryWorkflowOccurrence).toHaveBeenCalledExactlyOnceWith(
    admin,
    {
      p_root_session_id: entry.rootSessionId,
      p_workspace_id: entry.workspaceId,
      p_factory_id: entry.factoryId,
      p_expected_generation: entry.generation,
      p_ownership_token: entry.ownershipToken,
      occurrenceId: entry.occurrenceId,
      nodeId: entry.nodeId,
      workflowDigest: entry.workflowDigest,
    },
    { signal: expect.any(AbortSignal) },
  );
  expect(rpc.mock.calls[2]).toEqual([
    "finish_factory_workflow_authoring_dispatch",
    {
      p_session_id: entry.rootSessionId,
      p_input_run_id: entry.inputRunId,
      p_lease_id: leaseId,
      p_expected_generation: entry.generation,
    },
  ]);
});

it("does not execute when the queue is empty or leased to another worker", async () => {
  vi.clearAllMocks();
  const idle = fixture({ idle: true });
  const wrong = fixture({ wrongLease: true });

  await expect(drainAuthoredFactoryWorkflowEntry(idle.admin)).resolves.toBeUndefined();
  await expect(drainAuthoredFactoryWorkflowEntry(wrong.admin)).rejects.toThrow(
    "The authored workflow lease changed.",
  );
  expect(idle.rpc).toHaveBeenCalledOnce();
  expect(wrong.rpc).toHaveBeenCalledOnce();
  expect(executeFactoryWorkflowOccurrence).not.toHaveBeenCalled();
});

it("asks the native receipt to settle even when execution loses its result", async () => {
  vi.clearAllMocks();
  vi.mocked(executeFactoryWorkflowOccurrence).mockRejectedValueOnce(
    new Error("Lost execution response."),
  );
  const { rpc, admin } = fixture();

  await expect(drainAuthoredFactoryWorkflowEntry(admin)).rejects.toThrow(
    "Lost execution response.",
  );

  expect(rpc.mock.calls[1][0]).toBe("finish_factory_workflow_authoring_dispatch");
});
