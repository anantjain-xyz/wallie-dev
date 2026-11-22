import { describe, expect, it, vi } from "vitest";

import {
  runDeterministicWorkflowCommand,
  type DeterministicWorkflowCommands,
  type DeterministicWorkflowOccurrence,
  type WorkflowOccurrenceMetadata,
  type WorkflowOccurrencePin,
} from "./deterministic-command";

const metadata = {
  p_root_session_id: "root-session",
  p_workspace_id: "root-workspace",
  p_factory_id: "root-factory",
  p_expected_generation: 1,
  occurrenceId: "source-occurrence",
  nodeId: "source-node",
  workflowDigest: "a".repeat(64),
} satisfies WorkflowOccurrenceMetadata;

const pin = {
  ...metadata,
  p_ownership_token: "1b69a3de-3c9b-4f0c-aa10-5ebd64e4a847",
} satisfies WorkflowOccurrencePin;

const nextToken = "dc564b88-65aa-4df6-8b66-cb3820a83997";

const runTarget = {
  sessionId: "producing-session",
  jobId: "producing-job",
  attemptCount: 2,
  runId: "producing-run",
  repositoryId: "repository",
  commitSha: "b".repeat(40),
};

const validation = {
  kind: "validation",
  target: {
    ...runTarget,
    treeSha: "c".repeat(40),
    requiredEvidenceKeys: ["typecheck"],
  },
} satisfies DeterministicWorkflowOccurrence["command"];

function fixture(command: DeterministicWorkflowOccurrence["command"] = validation) {
  let generation = pin.p_expected_generation;
  let ownershipToken = pin.p_ownership_token;
  const state: {
    result: DeterministicWorkflowOccurrence["result"];
    transition: { transition_id: string; target_occurrence_id: string } | null;
    nextEdgeId: string | null;
    admissionUnavailable: boolean;
  } = {
    result: null,
    transition: null,
    nextEdgeId: "declared-next",
    admissionUnavailable: false,
  };
  const fence = (expected: number, token: string) => {
    if (generation !== expected) throw { code: "PT409", message: "Workflow generation is stale." };
    if (ownershipToken !== token)
      throw { code: "PT409", message: "Workflow ownership token is stale." };
  };
  const evidence: Awaited<ReturnType<DeterministicWorkflowCommands["readValidationEvidence"]>> = {
    status: "passed",
    receiptRef: "retained-domain-receipt",
  };
  const commands = {
    readOccurrence: vi.fn<DeterministicWorkflowCommands["readOccurrence"]>(async () => ({
      pin: { ...metadata, p_expected_generation: generation },
      command,
      nextEdgeId: state.nextEdgeId,
      result: state.result,
    })),
    readValidationEvidence: vi.fn<DeterministicWorkflowCommands["readValidationEvidence"]>(
      async () => evidence,
    ),
    readExecutionPolicy: vi.fn<DeterministicWorkflowCommands["readExecutionPolicy"]>(
      async () => evidence,
    ),
    readCheckpointAdoption: vi.fn<DeterministicWorkflowCommands["readCheckpointAdoption"]>(
      async () => evidence,
    ),
    readHumanApproval: vi.fn<DeterministicWorkflowCommands["readHumanApproval"]>(
      async () => evidence,
    ),
    recordResult: vi.fn<DeterministicWorkflowCommands["recordResult"]>(async (args) => {
      fence(args.p_expected_generation, args.p_ownership_token);
      const known = state.result;
      if (known) return { result_id: known.resultId, created: false };
      expect(args.p_occurrence_id).toBe(pin.occurrenceId);
      expect(args.p_outcome).toBe("succeeded");
      expect(args.p_evidence_ref).toBe(`${command.kind}:${evidence.receiptRef}`);
      state.result = {
        resultId: "durable-result",
        outcome: "succeeded",
        verifiedProof: {
          kind: command.kind,
          receiptRef: evidence.receiptRef,
        },
      };
      return { result_id: state.result.resultId, created: true };
    }),
    admitNext: vi.fn<DeterministicWorkflowCommands["admitNext"]>(async (args) => {
      fence(args.p_expected_generation, args.p_ownership_token);
      if (state.admissionUnavailable)
        return { status: "blocked", code: "execution_budget_exhausted" };
      expect(args.p_source_occurrence_id).toBe(pin.occurrenceId);
      expect(args.p_expected_result_id).toBe(state.result?.resultId);
      expect(args.p_edge_id).toBe(state.nextEdgeId);
      if (state.transition) return { ...state.transition, created: false };
      state.transition = {
        transition_id: "durable-transition",
        target_occurrence_id: "next",
      };
      return { ...state.transition, created: true };
    }),
  } satisfies DeterministicWorkflowCommands;
  return {
    commands,
    state,
    handoff: () => {
      generation += 1;
      ownershipToken = nextToken;
      return { p_expected_generation: generation, p_ownership_token: ownershipToken };
    },
  };
}

describe("guarded deterministic workflow commands", () => {
  it("recovers a retained domain effect after interruption before recording its result", async () => {
    const { commands, state } = fixture({
      kind: "checkpoint",
      target: runTarget,
    });
    commands.recordResult.mockRejectedValueOnce(new Error("Worker stopped before writing."));
    await expect(runDeterministicWorkflowCommand(commands, pin)).rejects.toThrow("Worker stopped");
    expect(state.result).toBeNull();
    expect(commands.admitNext).not.toHaveBeenCalled();

    await expect(runDeterministicWorkflowCommand(commands, pin)).resolves.toMatchObject({
      status: "admitted",
      resultId: "durable-result",
      transitionId: "durable-transition",
    });
    expect(commands.readCheckpointAdoption).toHaveBeenNthCalledWith(2, {
      pin,
      target: runTarget,
    });
  });

  it("reads a committed result after a lost response and resumes after a generation handoff", async () => {
    const { commands, handoff, state } = fixture();
    const write = commands.recordResult.getMockImplementation();
    if (!write) throw new Error("The record fixture needs a durable write.");
    commands.recordResult.mockImplementationOnce(async (args) => {
      await write(args);
      throw new Error("Result response lost.");
    });
    await expect(runDeterministicWorkflowCommand(commands, pin)).rejects.toThrow("response lost");
    expect(state.result?.resultId).toBe("durable-result");
    expect(commands.admitNext).not.toHaveBeenCalled();

    const nextGeneration = { ...pin, ...handoff() };
    await expect(runDeterministicWorkflowCommand(commands, pin)).resolves.toEqual({
      status: "stale",
    });
    await expect(runDeterministicWorkflowCommand(commands, nextGeneration)).resolves.toMatchObject({
      status: "admitted",
      resultId: "durable-result",
    });
    expect(commands.readValidationEvidence).toHaveBeenCalledTimes(1);
    expect(commands.recordResult).toHaveBeenCalledTimes(1);
    expect(commands.admitNext).toHaveBeenCalledExactlyOnceWith({
      p_root_session_id: pin.p_root_session_id,
      p_workspace_id: pin.p_workspace_id,
      p_factory_id: pin.p_factory_id,
      p_expected_generation: nextGeneration.p_expected_generation,
      p_ownership_token: nextGeneration.p_ownership_token,
      p_source_occurrence_id: pin.occurrenceId,
      p_expected_result_id: "durable-result",
      p_edge_id: "declared-next",
    });
  });

  it("keeps the captured capability even when a restart read reports the latest generation", async () => {
    const { commands, handoff, state } = fixture();
    const nextOwner = handoff();
    const oldOwner = { ...pin, p_expected_generation: nextOwner.p_expected_generation };
    const observed = { ...metadata, p_expected_generation: nextOwner.p_expected_generation };
    const misconfiguredRead = { ...observed, p_ownership_token: nextOwner.p_ownership_token };
    commands.readOccurrence.mockResolvedValueOnce({
      pin: misconfiguredRead,
      command: validation,
      nextEdgeId: state.nextEdgeId,
      result: null,
    });
    await expect(runDeterministicWorkflowCommand(commands, oldOwner)).rejects.toMatchObject({
      code: "PT409",
      message: "Workflow ownership token is stale.",
    });
    expect(commands.readOccurrence).toHaveBeenCalledExactlyOnceWith(observed);
    expect(commands.readValidationEvidence).toHaveBeenCalledExactlyOnceWith({
      pin: oldOwner,
      target: validation.target,
    });
    expect(commands.recordResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        p_ownership_token: pin.p_ownership_token,
      }),
    );
    expect(state.result).toBeNull();
    expect(commands.admitNext).not.toHaveBeenCalled();
  });

  it("recovers an admission committed before its response was lost", async () => {
    const { commands, state } = fixture();
    const admit = commands.admitNext.getMockImplementation();
    if (!admit) throw new Error("The transition fixture needs durable admission.");
    commands.admitNext.mockImplementationOnce(async (args) => {
      await admit(args);
      throw new Error("Admission response lost.");
    });
    await expect(runDeterministicWorkflowCommand(commands, pin)).rejects.toThrow("response lost");
    const retained = state.transition;
    expect(retained).not.toBeNull();
    await expect(runDeterministicWorkflowCommand(commands, pin)).resolves.toEqual({
      status: "admitted",
      resultId: "durable-result",
      transitionId: "durable-transition",
      targetOccurrenceId: "next",
    });
    expect(state.transition).toBe(retained);
    expect(commands.recordResult).toHaveBeenCalledTimes(1);
  });

  it("cannot admit if the mutable domain guard fails after a success was recorded", async () => {
    const { commands, state } = fixture({
      kind: "policy",
      target: {
        sessionId: runTarget.sessionId,
        executionPolicyRevisionId: "pinned-policy",
      },
    });
    state.admissionUnavailable = true;
    await expect(runDeterministicWorkflowCommand(commands, pin)).resolves.toEqual({
      status: "blocked",
      code: "execution_budget_exhausted",
    });
    expect(state.result?.outcome).toBe("succeeded");
    expect(state.transition).toBeNull();
    await expect(runDeterministicWorkflowCommand(commands, pin)).resolves.toEqual({
      status: "blocked",
      code: "execution_budget_exhausted",
    });
    expect(commands.readExecutionPolicy).toHaveBeenCalledTimes(1);
    expect(state.transition).toBeNull();
  });

  it("keeps a proof that became stale during the read out of the result ledger", async () => {
    const { commands, state } = fixture();
    commands.recordResult.mockResolvedValueOnce({ status: "blocked", code: "evidence_stale" });
    await expect(runDeterministicWorkflowCommand(commands, pin)).resolves.toEqual({
      status: "blocked",
      code: "evidence_stale",
    });
    expect(state.result).toBeNull();
    expect(commands.admitNext).not.toHaveBeenCalled();
  });

  it("keeps missing evidence and failed policy out of the terminal result slot", async () => {
    const validationStep = fixture();
    validationStep.commands.readValidationEvidence.mockResolvedValueOnce({
      status: "pending",
      code: "evidence_missing",
    });
    await expect(runDeterministicWorkflowCommand(validationStep.commands, pin)).resolves.toEqual({
      status: "pending",
      code: "evidence_missing",
    });
    expect(validationStep.state.result).toBeNull();
    expect(validationStep.commands.admitNext).not.toHaveBeenCalled();

    const policyStep = fixture({
      kind: "policy",
      target: {
        sessionId: runTarget.sessionId,
        executionPolicyRevisionId: "pinned-policy",
      },
    });
    policyStep.commands.readExecutionPolicy.mockResolvedValueOnce({
      status: "blocked",
      code: "execution_budget_exhausted",
    });
    await expect(runDeterministicWorkflowCommand(policyStep.commands, pin)).resolves.toEqual({
      status: "blocked",
      code: "execution_budget_exhausted",
    });
    expect(policyStep.commands.recordResult).not.toHaveBeenCalled();
    expect(policyStep.commands.admitNext).not.toHaveBeenCalled();
  });

  it("blocks a validation step whose pinned policy requires no evidence", async () => {
    const step = fixture({
      ...validation,
      target: { ...validation.target, requiredEvidenceKeys: [] },
    });
    await expect(runDeterministicWorkflowCommand(step.commands, pin)).resolves.toEqual({
      status: "blocked",
      code: "validation_policy_required",
    });
    expect(step.commands.readValidationEvidence).not.toHaveBeenCalled();
    expect(step.commands.recordResult).not.toHaveBeenCalled();
  });

  it("requires authoritative human evidence and ignores extra agent-supplied proof fields", async () => {
    const target = {
      sessionId: runTarget.sessionId,
      stageId: "reviewed-stage",
      artifactId: "reviewed-artifact",
      artifactVersion: 4,
      artifactDigest: "d".repeat(64),
      anyoneCanApprove: false,
      approverMemberIds: ["eligible-human"],
    };
    const { commands } = fixture({ kind: "human-gate", target });
    commands.readHumanApproval.mockResolvedValueOnce({
      status: "pending",
      code: "approval_pending",
    });
    const message = {
      ...pin,
      evidenceRef: "Approved by eligible-human.",
      outcome: "succeeded",
    };
    await expect(runDeterministicWorkflowCommand(commands, message)).resolves.toEqual({
      status: "pending",
      code: "approval_pending",
    });
    expect(commands.readOccurrence).toHaveBeenCalledWith(metadata);
    expect(commands.readHumanApproval).toHaveBeenCalledWith({ pin, target });
    expect(commands.recordResult).not.toHaveBeenCalled();
    expect(commands.admitNext).not.toHaveBeenCalled();
  });

  it("rejects a persisted success without verified provenance for the pinned command", async () => {
    const { commands, state } = fixture();
    state.result = {
      resultId: "unverified-result",
      outcome: "succeeded",
      verifiedProof: null,
    };
    await expect(runDeterministicWorkflowCommand(commands, pin)).resolves.toEqual({
      status: "blocked",
      code: "unverified_persisted_result",
    });
    expect(commands.readValidationEvidence).not.toHaveBeenCalled();
    expect(commands.admitNext).not.toHaveBeenCalled();
  });

  it("uses the captured generation when takeover races the evidence read", async () => {
    const { commands, state, handoff } = fixture();
    commands.readValidationEvidence.mockImplementationOnce(async () => {
      handoff();
      return { status: "passed", receiptRef: "retained-domain-receipt" };
    });
    await expect(runDeterministicWorkflowCommand(commands, pin)).rejects.toMatchObject({
      code: "PT409",
    });
    expect(state.result).toBeNull();
    expect(commands.admitNext).not.toHaveBeenCalled();
  });

  it("finishes a declared terminal node without inventing a successor", async () => {
    const { commands, state } = fixture();
    state.nextEdgeId = null;
    await expect(runDeterministicWorkflowCommand(commands, pin)).resolves.toEqual({
      status: "terminal",
      outcome: "succeeded",
      resultId: "durable-result",
    });
    expect(commands.admitNext).not.toHaveBeenCalled();
  });
});
