import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";
import { evaluateExactRunValidationEvidence } from "@/lib/validation-evidence/read-run-evidence";

import {
  runDeterministicWorkflowCommand,
  type DeterministicWorkflowCommands,
  type DeterministicWorkflowOccurrence,
  type WorkflowOccurrenceMetadata,
  type WorkflowOccurrencePin,
} from "./deterministic-command";
import { observeWorkflowCheckpoint, observeWorkflowHumanApproval } from "./observe-evidence";

type Admin = SupabaseClient<Database>;
type CommandTarget = DeterministicWorkflowOccurrence["command"];
type GraphNode = z.output<typeof workflowGraphSchema>["nodes"][number];

const snapshotSchema = z.object({
  execution: z.object({
    root_session_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    factory_id: z.string().uuid(),
    graph_revision_id: z.string().uuid(),
    graph_input_run_id: z.string().uuid().nullish(),
    workflow_json: z.string(),
    workflow_digest: z.string().regex(/^[0-9a-f]{64}$/),
    generation: z.number().int().positive().safe(),
  }),
  occurrences: z.array(z.object({ occurrence_id: z.string().uuid(), node_id: z.string() })),
  results: z.array(
    z.object({
      occurrence_id: z.string().uuid(),
      result_id: z.string().uuid(),
      outcome: z.enum(["succeeded", "failed", "canceled"]),
      evidence_ref: z.string().nullable(),
    }),
  ),
  transitions: z
    .array(
      z.object({
        source_occurrence_id: z.string().uuid(),
        source_result_id: z.string().uuid(),
        edge_id: z.string(),
      }),
    )
    .default([]),
});

async function loadCommandTarget(
  admin: Admin,
  node: GraphNode,
  pin: WorkflowOccurrencePin,
  inputRunId: string | null | undefined,
): Promise<CommandTarget | null> {
  if (node.kind === "deterministic" && node.operation === "policy") {
    const { data, error } = await admin
      .from("sessions")
      .select("execution_policy_revision_id")
      .eq("id", pin.p_root_session_id)
      .eq("workspace_id", pin.p_workspace_id)
      .eq("factory_id", pin.p_factory_id)
      .maybeSingle();
    if (error) throw error;
    if (!data?.execution_policy_revision_id) return null;
    return {
      kind: "policy",
      target: {
        sessionId: pin.p_root_session_id,
        executionPolicyRevisionId: data.execution_policy_revision_id,
      },
    };
  }
  if (!inputRunId || (node.kind !== "deterministic" && node.kind !== "human-gate")) return null;

  const { data: source, error: sourceError } = await admin
    .from("session_source_deliveries")
    .select("run_id, job_id, attempt_count, repository_id, head_sha")
    .eq("run_id", inputRunId)
    .eq("session_id", pin.p_root_session_id)
    .eq("workspace_id", pin.p_workspace_id)
    .maybeSingle();
  if (sourceError) throw sourceError;
  if (!source?.repository_id) return null;
  const run = {
    sessionId: pin.p_root_session_id,
    runId: source.run_id,
    jobId: source.job_id,
    attemptCount: source.attempt_count,
    repositoryId: source.repository_id,
    commitSha: source.head_sha,
  };

  if (node.kind === "deterministic" && node.operation === "checkpoint")
    return { kind: "checkpoint", target: run };

  if (node.kind === "deterministic") {
    const [plan, session] = await Promise.all([
      admin
        .from("session_validation_plans")
        .select("validation_tree_sha")
        .eq("workspace_id", pin.p_workspace_id)
        .eq("session_id", run.sessionId)
        .eq("run_id", run.runId)
        .eq("job_id", run.jobId)
        .eq("attempt_count", run.attemptCount)
        .eq("repository_id", run.repositoryId)
        .eq("commit_sha", run.commitSha)
        .maybeSingle(),
      admin
        .from("sessions")
        .select("pinned_delivery_policy_revision_id")
        .eq("id", run.sessionId)
        .eq("workspace_id", pin.p_workspace_id)
        .eq("factory_id", pin.p_factory_id)
        .maybeSingle(),
    ]);
    if (plan.error) throw plan.error;
    if (session.error) throw session.error;
    if (!plan.data || !session.data?.pinned_delivery_policy_revision_id) return null;
    const policy = await admin
      .from("delivery_policy_revisions")
      .select("requirements")
      .eq("id", session.data.pinned_delivery_policy_revision_id)
      .eq("workspace_id", pin.p_workspace_id)
      .maybeSingle();
    if (policy.error) throw policy.error;
    const requirements = deliveryRequirementsSchema.safeParse(policy.data?.requirements);
    if (!requirements.success) return null;
    return {
      kind: "validation",
      target: {
        ...run,
        treeSha: plan.data.validation_tree_sha,
        requiredEvidenceKeys: requirements.data.requiredEvidence,
      },
    };
  }

  const [publication, attempt] = await Promise.all([
    admin
      .from("session_checkpoint_publications")
      .select("artifact_id, artifact_md")
      .eq("workspace_id", pin.p_workspace_id)
      .eq("session_id", run.sessionId)
      .eq("run_id", run.runId)
      .eq("job_id", run.jobId)
      .eq("attempt_count", run.attemptCount)
      .eq("status", "adopted")
      .maybeSingle(),
    admin
      .from("agent_runs")
      .select("stage_id")
      .eq("workspace_id", pin.p_workspace_id)
      .eq("session_id", run.sessionId)
      .eq("id", run.runId)
      .eq("agent_job_id", run.jobId)
      .eq("attempt_count", run.attemptCount)
      .maybeSingle(),
  ]);
  if (publication.error) throw publication.error;
  if (attempt.error) throw attempt.error;
  if (!publication.data?.artifact_id || !attempt.data?.stage_id) return null;
  const artifact = await admin
    .from("session_artifacts")
    .select("version")
    .eq("workspace_id", pin.p_workspace_id)
    .eq("session_id", run.sessionId)
    .eq("stage_id", attempt.data.stage_id)
    .eq("id", publication.data.artifact_id)
    .maybeSingle();
  if (artifact.error) throw artifact.error;
  if (!artifact.data) return null;
  return {
    kind: "human-gate",
    target: {
      sessionId: run.sessionId,
      stageId: attempt.data.stage_id,
      artifactId: publication.data.artifact_id,
      artifactVersion: artifact.data.version,
      artifactDigest: createHash("sha256")
        .update(publication.data.artifact_md, "utf8")
        .digest("hex"),
      anyoneCanApprove: node.anyoneCanApprove,
      approverMemberIds: node.approverMemberIds,
    },
  };
}

async function readOccurrenceContext(admin: Admin, pin: WorkflowOccurrenceMetadata) {
  const scope = {
    p_workspace_id: pin.p_workspace_id,
    p_factory_id: pin.p_factory_id,
    p_root_session_id: pin.p_root_session_id,
  };
  const { data, error } = await admin.rpc("read_factory_workflow_execution", scope);
  if (error) throw error;
  const parsed = snapshotSchema.safeParse(data);
  if (!parsed.success) return { status: "unavailable" } as const;
  const { execution, occurrences, results, transitions } = parsed.data;
  const { workflow_json: json } = execution;
  if (
    execution.root_session_id !== pin.p_root_session_id ||
    execution.workspace_id !== pin.p_workspace_id ||
    execution.factory_id !== pin.p_factory_id ||
    execution.workflow_digest !== pin.workflowDigest ||
    createHash("sha256").update(json, "utf8").digest("hex") !== pin.workflowDigest
  )
    return { status: "unavailable" } as const;
  if (execution.generation !== pin.p_expected_generation) return { status: "stale" } as const;
  const decoded = parseFactoryDefinitionJson(json);
  const graph = workflowGraphSchema.safeParse(decoded.ok ? decoded.value : null);
  const occurrence = occurrences.find((row) => row.occurrence_id === pin.occurrenceId);
  if (!graph.success || occurrence?.node_id !== pin.nodeId)
    return { status: "unavailable" } as const;
  const node = graph.data.nodes.find((candidate) => candidate.id === pin.nodeId);
  if (!node) return { status: "unavailable" } as const;
  return {
    status: "current" as const,
    scope,
    execution,
    occurrence,
    node,
    results,
    transitions,
    edges: graph.data.edges,
  };
}

/** The recovery controller explicitly hands off an observed occurrence before continuing it. */
export async function resumeFactoryWorkflowOccurrence(
  admin: Admin,
  pin: WorkflowOccurrenceMetadata,
) {
  const observed = await readOccurrenceContext(admin, pin);
  if (observed.status !== "current") return { ownership: null, progress: observed };
  const { data: ownership, error } = await admin
    .rpc("advance_factory_workflow_generation", {
      ...observed.scope,
      p_expected_generation: pin.p_expected_generation,
    })
    .single();
  if (error) throw error;
  const progress = await executeFactoryWorkflowOccurrence(admin, {
    ...pin,
    p_expected_generation: ownership.execution_generation,
    p_ownership_token: ownership.ownership_token,
  });
  return { ownership, progress };
}

/** The worker supplies the captured ownership token. Scope and proof targets come from the ledger. */
export async function executeFactoryWorkflowOccurrence(admin: Admin, pin: WorkflowOccurrencePin) {
  const observed = await readOccurrenceContext(admin, pin);
  if (observed.status !== "current") return observed;
  const { scope, execution, occurrence, node, results, transitions, edges } = observed;
  const nextEdge = edges.find((edge) => edge.kind === "next" && edge.from === pin.nodeId);
  const admitNext: DeterministicWorkflowCommands["admitNext"] = async (args) => {
    const result = await admin.rpc("admit_factory_workflow_next", args).maybeSingle();
    if (result.error) throw result.error;
    return result.data ?? { status: "blocked", code: "evidence_stale" };
  };
  const accepted = transitions.find(
    (transition) =>
      transition.source_occurrence_id === pin.occurrenceId && transition.edge_id === nextEdge?.id,
  );
  if (accepted && nextEdge) {
    const receipt = await admitNext({
      ...scope,
      p_expected_generation: pin.p_expected_generation,
      p_ownership_token: pin.p_ownership_token,
      p_source_occurrence_id: pin.occurrenceId,
      p_edge_id: accepted.edge_id,
      p_expected_result_id: accepted.source_result_id,
    });
    return "status" in receipt
      ? receipt
      : {
          status: "admitted" as const,
          resultId: accepted.source_result_id,
          transitionId: receipt.transition_id,
          targetOccurrenceId: receipt.target_occurrence_id,
          nextNodeId: nextEdge.to,
        };
  }
  const command = await loadCommandTarget(admin, node, pin, execution.graph_input_run_id);
  if (!command) return { status: "pending", code: "evidence_missing" } as const;
  const stored = results.find((row) => row.occurrence_id === pin.occurrenceId);
  const prefix = command.kind + ":";
  const proofRef = stored?.evidence_ref?.startsWith(prefix)
    ? stored.evidence_ref.slice(prefix.length)
    : null;
  const captured: DeterministicWorkflowOccurrence = {
    pin: {
      ...scope,
      p_expected_generation: execution.generation,
      occurrenceId: pin.occurrenceId,
      nodeId: occurrence.node_id,
      workflowDigest: execution.workflow_digest,
    },
    command,
    nextEdgeId: nextEdge?.id ?? null,
    result:
      stored?.outcome === "succeeded"
        ? {
            resultId: stored.result_id,
            outcome: "succeeded",
            verifiedProof: proofRef ? { kind: command.kind, receiptRef: proofRef } : null,
          }
        : stored
          ? { resultId: stored.result_id, outcome: stored.outcome }
          : null,
  };

  const adapters: DeterministicWorkflowCommands = {
    readOccurrence: async () => captured,
    readExecutionPolicy: async ({ pin: current, target }) => {
      const evaluated = await admin
        .rpc("check_factory_workflow_execution_policy", {
          ...scope,
          p_expected_generation: current.p_expected_generation,
          p_ownership_token: current.p_ownership_token,
          p_occurrence_id: current.occurrenceId,
        })
        .single();
      if (evaluated.error) throw evaluated.error;
      if (evaluated.data.policy_revision_id !== target.executionPolicyRevisionId)
        return { status: "pending", code: "evidence_missing" };
      if (evaluated.data.exhaustion_code)
        return { status: "blocked", code: "execution_budget_exhausted" };
      return { status: "passed", receiptRef: target.executionPolicyRevisionId };
    },
    readCheckpointAdoption: (input) => observeWorkflowCheckpoint({ admin, ...input }),
    readHumanApproval: (input) => observeWorkflowHumanApproval({ admin, ...input }),
    readValidationEvidence: async ({ pin: current, target }) => {
      const checkpoint = await observeWorkflowCheckpoint({ admin, pin: current, target });
      if (checkpoint.status !== "passed") return checkpoint;
      const outcomes = await evaluateExactRunValidationEvidence({
        admin,
        source: {
          workspace_id: current.p_workspace_id,
          session_id: target.sessionId,
          run_id: target.runId,
          job_id: target.jobId,
          attempt_count: target.attemptCount,
          repository_id: target.repositoryId,
          output_sha: target.commitSha,
          validation_tree_sha: target.treeSha,
        },
        requiredKeys: [...target.requiredEvidenceKeys],
      });
      if (outcomes.some(({ status }) => status === "failed"))
        return { status: "blocked", code: "evidence_failed" };
      if (outcomes.some(({ status }) => status === "stale"))
        return { status: "blocked", code: "evidence_stale" };
      if (outcomes.some(({ status }) => status === "unavailable"))
        return { status: "blocked", code: "evidence_unavailable" };
      if (!outcomes.length || outcomes.some(({ status }) => status !== "passed"))
        return { status: "pending", code: "evidence_missing" };
      return { status: "passed", receiptRef: target.runId };
    },
    recordResult: async ({
      p_evidence_ref,
      p_expected_generation,
      p_ownership_token,
      p_occurrence_id,
    }) => {
      if (!p_evidence_ref) return { status: "blocked", code: "evidence_unavailable" };
      const result = await admin
        .rpc("record_factory_workflow_command_result", {
          ...scope,
          p_expected_generation,
          p_ownership_token,
          p_occurrence_id,
          p_evidence_ref,
        })
        .maybeSingle();
      if (result.error) throw result.error;
      return result.data ?? { status: "blocked", code: "evidence_stale" };
    },
    admitNext,
  };
  const progress = await runDeterministicWorkflowCommand(adapters, pin);
  return progress.status === "admitted" && nextEdge
    ? { ...progress, nextNodeId: nextEdge.to }
    : progress;
}
