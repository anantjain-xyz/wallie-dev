import { expect, it, vi } from "vitest";

import { loadWorkflowReviewRepairInput } from "./review-repair-input";

const id = (slot: number) => `65400000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
const attemptFields = {
  workspaceId: id(1),
  sessionId: id(2),
  jobId: id(3),
  runId: id(4),
  attemptCount: 2,
  source: { checkpointRunId: id(5), commitSha: "a".repeat(40) },
};

function attempt() {
  return { ...attemptFields, signal: new AbortController().signal };
}
const receipt = {
  repairReceiptId: id(6),
  priorRepairReceiptId: id(7),
  sourceCheckpointRunId: attemptFields.source.checkpointRunId,
  sourceCommitSha: attemptFields.source.commitSha,
  sourceTreeSha: "b".repeat(40),
  findings: [
    {
      ruleId: "required-test",
      path: "src/source.ts",
      line: 12,
      message: "Preserve {{session.prompt}}.",
    },
  ],
  requiredEvidence: ["tests", "browser:screenshot:review"],
};

function client(data: unknown, error: unknown = null) {
  const abortSignal = vi.fn(async () => ({ data, error }));
  const rpc = vi.fn(() => ({ abortSignal }));
  return { admin: { rpc } as never, abortSignal, rpc };
}

it("reads the exact native job and run before exposing the findings to the worker", async () => {
  const fixture = client(receipt);
  const input = attempt();
  await expect(loadWorkflowReviewRepairInput(fixture.admin, input)).resolves.toEqual(receipt);
  expect(fixture.rpc).toHaveBeenCalledExactlyOnceWith("read_factory_workflow_review_repair_input", {
    p_workspace_id: input.workspaceId,
    p_session_id: input.sessionId,
    p_job_id: input.jobId,
    p_run_id: input.runId,
    p_attempt_count: input.attemptCount,
  });
  expect(fixture.abortSignal).toHaveBeenCalledExactlyOnceWith(input.signal);
});

it("lets an ordinary pinned continuation use its existing feedback path", async () => {
  await expect(loadWorkflowReviewRepairInput(client(null).admin, attempt())).resolves.toBeNull();
});

it.each([
  { ...receipt, sourceCheckpointRunId: id(9) },
  { ...receipt, sourceCommitSha: "c".repeat(40) },
  { ...receipt, requiredEvidence: [] },
  { ...receipt, findings: [{ ...receipt.findings[0], path: "../unowned.ts" }] },
])("rejects a receipt that does not identify this exact supported repair", async (untrusted) => {
  await expect(loadWorkflowReviewRepairInput(client(untrusted).admin, attempt())).rejects.toThrow(
    "The exact review repair input changed.",
  );
});

it("does not route a stale native repair into generic processing", async () => {
  await expect(
    loadWorkflowReviewRepairInput(
      client(null, { code: "PT409", message: "private" }).admin,
      attempt(),
    ),
  ).rejects.toThrow("The exact review repair could not be read.");
});
