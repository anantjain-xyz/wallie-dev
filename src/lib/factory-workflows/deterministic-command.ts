import type { Database } from "@/lib/supabase/database.types";

type Functions = Database["public"]["Functions"];
type ReadExecutionArgs = Functions["read_factory_workflow_execution"]["Args"];
type RecordResult = Functions["record_factory_workflow_node_result"];
type AdmitNext = Functions["admit_factory_workflow_next"];

export type WorkflowOccurrenceMetadata = ReadExecutionArgs & {
  readonly p_expected_generation: RecordResult["Args"]["p_expected_generation"];
  readonly occurrenceId: string;
  readonly nodeId: string;
  readonly workflowDigest: string;
};

export type WorkflowOccurrencePin = WorkflowOccurrenceMetadata & {
  readonly p_ownership_token: RecordResult["Args"]["p_ownership_token"];
};

type RunTarget = {
  readonly sessionId: string;
  readonly jobId: string;
  readonly attemptCount: number;
  readonly runId: string;
  readonly repositoryId: string;
  readonly commitSha: string;
};

type DeterministicCommand =
  | {
      kind: "validation";
      target: RunTarget & {
        treeSha: string;
        requiredEvidenceKeys: readonly string[];
      };
    }
  | {
      kind: "policy";
      target: { sessionId: string; executionPolicyRevisionId: string };
    }
  | { kind: "checkpoint"; target: RunTarget }
  | {
      kind: "human-gate";
      target: {
        sessionId: string;
        stageId: string;
        artifactId: string;
        artifactVersion: number;
        artifactDigest: string;
        anyoneCanApprove: boolean;
        approverMemberIds: readonly string[];
      };
    };

type CommandKind = DeterministicCommand["kind"];

type NonAdvancingObservation =
  | {
      status: "pending";
      code: "evidence_missing" | "approval_pending" | "checkpoint_pending";
    }
  | {
      status: "blocked";
      code:
        | "evidence_unavailable"
        | "validation_policy_required"
        | "evidence_failed"
        | "evidence_stale"
        | "execution_budget_exhausted"
        | "approval_blocked"
        | "checkpoint_unavailable";
    };

type CommandObservation = NonAdvancingObservation | { status: "passed"; receiptRef: string };

export const workflowVisitLimitBlocker = {
  status: "blocked",
  code: "workflow_visit_limit_exhausted",
} as const;

type CapturedCommandResult =
  | {
      resultId: string;
      outcome: "succeeded";
      verifiedProof: { kind: CommandKind; receiptRef: string } | null;
    }
  | { resultId: string; outcome: "failed" | "canceled" };

export type DeterministicWorkflowOccurrence = {
  pin: WorkflowOccurrenceMetadata;
  command: DeterministicCommand;
  nextEdgeId: string | null;
  result: CapturedCommandResult | null;
};

type EvidenceReader<Kind extends CommandKind> = (input: {
  pin: WorkflowOccurrencePin;
  target: Extract<DeterministicCommand, { kind: Kind }>["target"];
}) => Promise<CommandObservation>;

/** Ledger reads and evidence adapters run inside the trusted worker boundary. */
export type DeterministicWorkflowCommands = {
  // Decode a single ledger snapshot. Derive targets and the edge only from the
  // pinned workflow, occurrence, and trusted predecessor receipts. A raw
  // result evidence_ref alone never qualifies as a verifiedProof. Neither the
  // input nor the returned metadata carries an ownership capability.
  readOccurrence(pin: WorkflowOccurrenceMetadata): Promise<DeterministicWorkflowOccurrence | null>;
  readValidationEvidence: EvidenceReader<"validation">;
  readExecutionPolicy: EvidenceReader<"policy">;
  readCheckpointAdoption: EvidenceReader<"checkpoint">;
  readHumanApproval: EvidenceReader<"human-gate">;
  // Revalidate mutable domain predicates in the transaction that records or
  // admits success. An evidence reference is an expected identity, not proof.
  // Return current domain blockers and reject stale ownership.
  recordResult(
    args: RecordResult["Args"],
  ): Promise<RecordResult["Returns"][number] | NonAdvancingObservation>;
  admitNext(
    args: AdmitNext["Args"],
  ): Promise<
    AdmitNext["Returns"][number] | NonAdvancingObservation | typeof workflowVisitLimitBlocker
  >;
};

type CommandProgress =
  | { status: "stale" | "unavailable" }
  | NonAdvancingObservation
  | { status: "blocked"; code: "unverified_persisted_result" }
  | {
      status: "terminal";
      outcome: CapturedCommandResult["outcome"];
      resultId: string;
      successorBlocked?: typeof workflowVisitLimitBlocker.code;
    }
  | {
      status: "admitted";
      resultId: string;
      transitionId: string;
      targetOccurrenceId: string;
    };

async function readCommandEvidence(
  commands: DeterministicWorkflowCommands,
  command: DeterministicCommand,
  pin: WorkflowOccurrencePin,
): Promise<CommandObservation> {
  switch (command.kind) {
    case "validation":
      if (command.target.requiredEvidenceKeys.length === 0)
        return { status: "blocked", code: "validation_policy_required" };
      return commands.readValidationEvidence({ pin, target: command.target });
    case "policy":
      return commands.readExecutionPolicy({ pin, target: command.target });
    case "checkpoint":
      return commands.readCheckpointAdoption({ pin, target: command.target });
    case "human-gate":
      return commands.readHumanApproval({ pin, target: command.target });
  }
}

export async function runDeterministicWorkflowCommand(
  commands: DeterministicWorkflowCommands,
  pin: WorkflowOccurrencePin,
): Promise<CommandProgress> {
  const scope = {
    p_root_session_id: pin.p_root_session_id,
    p_workspace_id: pin.p_workspace_id,
    p_factory_id: pin.p_factory_id,
    p_expected_generation: pin.p_expected_generation,
  };
  const captured = {
    ...scope,
    occurrenceId: pin.occurrenceId,
    nodeId: pin.nodeId,
    workflowDigest: pin.workflowDigest,
  };
  const p_ownership_token = pin.p_ownership_token;
  const occurrence = await commands.readOccurrence(captured);
  if (
    !occurrence ||
    occurrence.pin.p_root_session_id !== captured.p_root_session_id ||
    occurrence.pin.p_workspace_id !== captured.p_workspace_id ||
    occurrence.pin.p_factory_id !== captured.p_factory_id ||
    occurrence.pin.occurrenceId !== captured.occurrenceId ||
    occurrence.pin.nodeId !== captured.nodeId ||
    occurrence.pin.workflowDigest !== captured.workflowDigest
  ) {
    return { status: "unavailable" };
  }
  if (occurrence.pin.p_expected_generation !== captured.p_expected_generation) {
    return { status: "stale" };
  }

  const { command, result, nextEdgeId } = occurrence;
  const ownership = { ...scope, p_ownership_token };
  let resultId: string;
  if (result) {
    if (result.outcome !== "succeeded") {
      return {
        status: "terminal",
        outcome: result.outcome,
        resultId: result.resultId,
      };
    }
    if (result.verifiedProof?.kind !== command.kind || !result.verifiedProof.receiptRef.trim()) {
      return { status: "blocked", code: "unverified_persisted_result" };
    }
    resultId = result.resultId;
  } else {
    const observation = await readCommandEvidence(commands, command, {
      ...captured,
      p_ownership_token,
    });
    if (observation.status !== "passed") return observation;
    if (!observation.receiptRef.trim())
      throw new Error("A verified evidence identity is required.");
    const receipt = await commands.recordResult({
      ...ownership,
      p_occurrence_id: captured.occurrenceId,
      p_outcome: "succeeded",
      p_evidence_ref: `${command.kind}:${observation.receiptRef}`,
    });
    if ("status" in receipt) return receipt;
    resultId = receipt.result_id;
  }

  if (nextEdgeId === null) return { status: "terminal", outcome: "succeeded", resultId };
  const transition = await commands.admitNext({
    ...ownership,
    p_source_occurrence_id: captured.occurrenceId,
    p_expected_result_id: resultId,
    p_edge_id: nextEdgeId,
  });
  if ("status" in transition) {
    if (transition.code === workflowVisitLimitBlocker.code)
      return {
        status: "terminal",
        outcome: "succeeded",
        resultId,
        successorBlocked: transition.code,
      };
    return transition;
  }
  return {
    status: "admitted",
    resultId,
    transitionId: transition.transition_id,
    targetOccurrenceId: transition.target_occurrence_id,
  };
}
