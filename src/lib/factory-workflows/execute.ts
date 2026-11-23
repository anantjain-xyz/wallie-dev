import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { workflowGraphSchema } from "@/lib/factory-definitions/workflow-schema";
import type { Database } from "@/lib/supabase/database.types";
import { evaluateExactRunValidationEvidence } from "@/lib/validation-evidence/read-run-evidence";

import { advanceFactoryWorkflowBranchOccurrence } from "./branch-dispatch";
import {
  type WorkflowDelegationRequest,
  workflowDelegationRequestSchema,
} from "./delegation-request";
import {
  runDeterministicWorkflowCommand,
  type DeterministicWorkflowCommands,
  type DeterministicWorkflowOccurrence,
  type WorkflowOccurrenceMetadata,
  type WorkflowOccurrencePin,
  workflowVisitLimitBlocker,
} from "./deterministic-command";
import { executeFactoryWorkflowForeman } from "./foreman-store";
import { observeWorkflowCheckpoint, observeWorkflowHumanApproval } from "./observe-evidence";
import { parseWorkflowRouteProposal } from "./route-decision";

type Admin = SupabaseClient<Database>;
type CommandTarget = DeterministicWorkflowOccurrence["command"];
type GraphNode = z.output<typeof workflowGraphSchema>["nodes"][number];
type WorkflowScope = Pick<
  WorkflowOccurrenceMetadata,
  "p_root_session_id" | "p_workspace_id" | "p_factory_id"
>;
type ValidationPolicyBlocker = { status: "blocked"; code: "validation_policy_required" };

const routeDecisionId = z.object({ decision_id: z.string().uuid() });
const routeDecisionReceiptSchema = z.union([
  routeDecisionId.extend({
    resolution: z.enum(["selected", "fallback"]),
    transition_id: z.string().uuid(),
    target_occurrence_id: z.string().uuid(),
  }),
  routeDecisionId.extend({
    resolution: z.literal("clarification"),
    transition_id: z.null(),
    target_occurrence_id: z.null(),
  }),
]);

function isWorkflowVisitLimitError(error: PostgrestError) {
  return error.code === "PT409" && error.details === workflowVisitLimitBlocker.code;
}

function routeDecisionProgress(value: unknown) {
  const receipt = routeDecisionReceiptSchema.parse(value);
  const decision = { status: "route_decided" as const, decisionId: receipt.decision_id };
  if (receipt.resolution === "clarification")
    return { ...decision, resolution: receipt.resolution };
  return {
    ...decision,
    resolution: receipt.resolution,
    transitionId: receipt.transition_id,
    targetOccurrenceId: receipt.target_occurrence_id,
  };
}

const snapshotSchema = z.object({
  execution: z.object({
    root_session_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    factory_id: z.string().uuid(),
    graph_revision_id: z.string().uuid(),
    graph_input_run_id: z.string().uuid().nullish(),
    graph_visit_limit_exhausted: z.boolean().optional(),
    graph_route_blocker: z
      .enum(["root_unavailable", "execution_policy_required", "execution_budget_exhausted"])
      .optional(),
    workflow_json: z.string(),
    workflow_digest: z.string().regex(/^[0-9a-f]{64}$/),
    generation: z.number().int().positive().safe(),
  }),
  occurrences: z.array(
    z.object({
      occurrence_id: z.string().uuid(),
      node_id: z.string(),
      is_entry: z.boolean().optional(),
    }),
  ),
  results: z.array(
    z.object({
      occurrence_id: z.string().uuid(),
      result_id: z.string().uuid(),
      outcome: z.enum(["succeeded", "failed", "canceled"]),
    }),
  ),
});

async function readRequiredValidationKeys(admin: Admin, scope: WorkflowScope, sessionId: string) {
  const session = await admin
    .from("sessions")
    .select("pinned_delivery_policy_revision_id")
    .eq("id", sessionId)
    .eq("workspace_id", scope.p_workspace_id)
    .eq("factory_id", scope.p_factory_id)
    .maybeSingle();
  if (session.error) throw session.error;
  if (!session.data?.pinned_delivery_policy_revision_id) return [];
  const policy = await admin
    .from("delivery_policy_revisions")
    .select("requirements")
    .eq("id", session.data.pinned_delivery_policy_revision_id)
    .eq("workspace_id", scope.p_workspace_id)
    .maybeSingle();
  if (policy.error) throw policy.error;
  const requirements = deliveryRequirementsSchema.safeParse(policy.data?.requirements);
  return requirements.success ? requirements.data.requiredEvidence : [];
}

async function loadCommandTarget(
  admin: Admin,
  node: GraphNode,
  pin: WorkflowOccurrencePin,
  input: { sessionId: string; runId: string } | null,
): Promise<CommandTarget | ValidationPolicyBlocker | null> {
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
  const validationKeys =
    node.kind === "deterministic" && node.operation === "validation"
      ? await readRequiredValidationKeys(admin, pin, input?.sessionId ?? pin.p_root_session_id)
      : null;
  if (validationKeys?.length === 0)
    return { status: "blocked", code: "validation_policy_required" };
  if (!input || (node.kind !== "deterministic" && node.kind !== "human-gate")) return null;

  const { data: source, error: sourceError } = await admin
    .from("session_source_deliveries")
    .select("run_id, job_id, attempt_count, repository_id, head_sha")
    .eq("run_id", input.runId)
    .eq("session_id", input.sessionId)
    .eq("workspace_id", pin.p_workspace_id)
    .maybeSingle();
  if (sourceError) throw sourceError;
  if (!source?.repository_id) return null;
  const run = {
    sessionId: input.sessionId,
    runId: source.run_id,
    jobId: source.job_id,
    attemptCount: source.attempt_count,
    repositoryId: source.repository_id,
    commitSha: source.head_sha,
  };

  if (node.kind === "deterministic" && node.operation === "checkpoint")
    return { kind: "checkpoint", target: run };

  if (node.kind === "deterministic" && validationKeys) {
    const plan = await admin
      .from("session_validation_plans")
      .select("validation_tree_sha")
      .eq("workspace_id", pin.p_workspace_id)
      .eq("session_id", run.sessionId)
      .eq("run_id", run.runId)
      .eq("job_id", run.jobId)
      .eq("attempt_count", run.attemptCount)
      .eq("repository_id", run.repositoryId)
      .eq("commit_sha", run.commitSha)
      .maybeSingle();
    if (plan.error) throw plan.error;
    if (!plan.data) return null;
    return {
      kind: "validation",
      target: {
        ...run,
        treeSha: plan.data.validation_tree_sha,
        requiredEvidenceKeys: validationKeys,
      },
    };
  }
  if (node.kind !== "human-gate") return null;

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

async function readWorkflowSnapshot(admin: Admin, scope: WorkflowScope) {
  const { data, error } = await admin.rpc("read_factory_workflow_execution", scope);
  if (error) throw error;
  const parsed = snapshotSchema.safeParse(data);
  if (!parsed.success) return null;
  const { execution } = parsed.data;
  const { workflow_json: json } = execution;
  if (
    execution.root_session_id !== scope.p_root_session_id ||
    execution.workspace_id !== scope.p_workspace_id ||
    execution.factory_id !== scope.p_factory_id ||
    createHash("sha256").update(json, "utf8").digest("hex") !== execution.workflow_digest
  )
    return null;
  const decoded = parseFactoryDefinitionJson(json);
  const graph = workflowGraphSchema.safeParse(decoded.ok ? decoded.value : null);
  return graph.success ? { ...parsed.data, graph: graph.data } : null;
}

async function readOccurrenceContext(admin: Admin, pin: WorkflowOccurrenceMetadata) {
  const scope = {
    p_workspace_id: pin.p_workspace_id,
    p_factory_id: pin.p_factory_id,
    p_root_session_id: pin.p_root_session_id,
  };
  const snapshot = await readWorkflowSnapshot(admin, scope);
  if (!snapshot || snapshot.execution.workflow_digest !== pin.workflowDigest)
    return { status: "unavailable" } as const;
  const { execution, occurrences, results, graph } = snapshot;
  const occurrence = occurrences.find((row) => row.occurrence_id === pin.occurrenceId);
  if (occurrence?.node_id !== pin.nodeId) return { status: "unavailable" } as const;
  if (execution.generation !== pin.p_expected_generation)
    return { status: "stale", currentGeneration: execution.generation } as const;
  const node = graph.nodes.find((candidate) => candidate.id === pin.nodeId);
  if (!node) return { status: "unavailable" } as const;
  return {
    status: "current" as const,
    scope,
    execution,
    occurrence,
    node,
    results,
    graph,
  };
}

export async function resumeEnrolledFactoryWorkflowGraph(
  admin: Admin,
  scope: WorkflowScope,
  generation: number,
) {
  const snapshot = await readWorkflowSnapshot(admin, scope);
  const occurrence = snapshot?.occurrences.find((candidate) => candidate.is_entry);
  if (!snapshot || !occurrence || occurrence.node_id !== snapshot.graph.entryNodeId)
    return { entry: null, ownership: null, progress: { status: "unavailable" } } as const;
  const entry = {
    ...scope,
    p_expected_generation: generation,
    occurrenceId: occurrence.occurrence_id,
    nodeId: occurrence.node_id,
    workflowDigest: snapshot.execution.workflow_digest,
  };
  const { ownership, progress } = await resumeFactoryWorkflowOccurrence(admin, entry);
  const currentGeneration =
    ownership?.execution_generation ??
    (progress.status === "stale" && "currentGeneration" in progress
      ? progress.currentGeneration
      : snapshot.execution.generation);
  return { entry: { ...entry, p_expected_generation: currentGeneration }, ownership, progress };
}

/** The recovery controller explicitly hands off an observed occurrence before continuing it. */
export async function resumeFactoryWorkflowOccurrence(
  admin: Admin,
  pin: WorkflowOccurrenceMetadata,
) {
  const observed = await readOccurrenceContext(admin, pin);
  if (observed.status !== "current") return { ownership: null, progress: observed };
  // A transport failure can follow a committed handoff. Retry the same
  // candidate capability so recovery cannot take over a competing owner.
  const candidate = randomUUID();
  const acquire = async () => {
    const { data, error } = await admin
      .rpc("acquire_factory_workflow_ownership", {
        ...observed.scope,
        p_expected_generation: pin.p_expected_generation,
        p_candidate_ownership_token: candidate,
      })
      .maybeSingle();
    if (error) throw error;
    return data;
  };
  let ownership;
  try {
    ownership = await acquire();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code) throw error;
    ownership = await acquire();
  }
  if (!ownership) {
    const latest = await readOccurrenceContext(admin, pin);
    return {
      ownership: null,
      progress: latest.status === "stale" ? latest : { status: "unavailable" as const },
    };
  }
  if (
    ownership.execution_generation !== pin.p_expected_generation + 1 ||
    ownership.ownership_token !== candidate
  )
    throw new Error("The workflow handoff returned a different ownership receipt.");
  const progress = await executeFactoryWorkflowOccurrence(admin, {
    ...pin,
    p_expected_generation: ownership.execution_generation,
    p_ownership_token: ownership.ownership_token,
  });
  return { ownership, progress };
}

/** Submit bounded agent output for the exact owned route occurrence. */
export async function submitFactoryWorkflowRouteProposal(
  admin: Admin,
  pin: WorkflowOccurrencePin,
  rawProposal: string,
) {
  const parsed = parseWorkflowRouteProposal(rawProposal);
  if (!parsed.ok) return { status: "blocked", code: parsed.code } as const;
  const observed = await readOccurrenceContext(admin, pin);
  if (observed.status !== "current") return observed;
  const { scope, node, graph, execution } = observed;
  if (
    node.kind !== "route" ||
    !graph.routePolicy ||
    !Object.hasOwn(graph.routePolicy.nodes, node.id)
  )
    return { status: "blocked", code: "invalid_route_policy" } as const;

  const proposal = parsed.proposal;
  const policy = graph.routePolicy.nodes[node.id];
  if (
    proposal.kind === "choose" &&
    !policy.allowedDestinationIds.some(
      (destinationId) => destinationId === proposal.destinationNodeId,
    )
  )
    return { status: "blocked", code: "destination_not_allowed" } as const;
  const { data, error } = await admin
    .rpc("admit_factory_workflow_route_decision", {
      ...scope,
      p_expected_generation: pin.p_expected_generation,
      p_ownership_token: pin.p_ownership_token,
      p_route_occurrence_id: pin.occurrenceId,
      p_reason: proposal.reason,
      ...(proposal.kind === "choose"
        ? { p_destination_id: proposal.destinationNodeId, p_confidence: proposal.confidence }
        : {}),
    })
    .maybeSingle();
  if (error) {
    if (isWorkflowVisitLimitError(error)) return workflowVisitLimitBlocker;
    throw error;
  }
  return data === null
    ? ({
        status: "blocked",
        code: execution.graph_route_blocker ?? "execution_budget_exhausted",
      } as const)
    : routeDecisionProgress(data);
}

const workflowDelegationReceiptSchema = z.object({
  child_session_id: z.string().uuid(),
  job_id: z.string().uuid(),
  run_id: z.string().uuid(),
  created: z.boolean(),
});

type DelegationArgs =
  Database["public"]["Functions"]["admit_factory_workflow_delegated_session"]["Args"];

export type WorkflowDelegationPin = WorkflowOccurrencePin & {
  readonly parentSessionId: DelegationArgs["p_parent_session_id"];
  readonly sourceCheckpointRunId: DelegationArgs["p_source_checkpoint_run_id"];
};

export type { WorkflowDelegationRequest } from "./delegation-request";

/** Admit explicitly requested work. The native ledger verifies the route, ancestry, source and budget. */
export async function admitFactoryWorkflowDelegatedSession(
  admin: Admin,
  pin: WorkflowDelegationPin,
  request: WorkflowDelegationRequest,
) {
  const parsed = workflowDelegationRequestSchema.safeParse(request);
  if (!parsed.success) return { status: "blocked", code: "invalid_delegation_request" } as const;
  const observed = await readOccurrenceContext(admin, pin);
  if (observed.status !== "current") return observed;
  const { scope, execution, occurrence, node, graph } = observed;
  if (
    node.kind !== "agent" ||
    !graph.delegationPolicy ||
    !Object.hasOwn(graph.delegationPolicy.targets, node.id)
  ) {
    return { status: "blocked", code: "invalid_delegation_target" } as const;
  }

  const { data, error } = await admin
    .rpc("admit_factory_workflow_delegated_session", {
      ...scope,
      p_expected_generation: execution.generation,
      p_ownership_token: pin.p_ownership_token,
      p_parent_session_id: pin.parentSessionId,
      p_target_occurrence_id: occurrence.occurrence_id,
      p_source_checkpoint_run_id: pin.sourceCheckpointRunId,
      p_title: parsed.data.title,
      p_prompt_md: parsed.data.promptMd,
    })
    .single();
  if (error) throw error;
  return { status: "delegated", receipt: workflowDelegationReceiptSchema.parse(data) } as const;
}

/** The worker supplies the captured ownership token. Scope and proof targets come from the ledger. */
export async function executeFactoryWorkflowOccurrence(
  admin: Admin,
  pin: WorkflowOccurrencePin,
  options?: { signal?: AbortSignal },
) {
  const observed = await readOccurrenceContext(admin, pin);
  if (observed.status !== "current") return observed;
  const { scope, execution, occurrence, node, results, graph } = observed;
  if (
    node.kind === "branch" ||
    (node.kind === "agent" &&
      graph.edges.some((edge) => edge.kind === "branch" && edge.to === node.id))
  ) {
    return advanceFactoryWorkflowBranchOccurrence(admin, pin, options?.signal);
  }
  if (node.kind === "route") {
    if (!graph.routePolicy || !Object.hasOwn(graph.routePolicy.nodes, node.id))
      return { status: "blocked", code: "invalid_route_policy" } as const;
    const { data, error } = await admin.rpc("read_factory_workflow_route_decision", {
      ...scope,
      p_route_occurrence_id: occurrence.occurrence_id,
    });
    if (error) throw error;
    const decision = data === null ? null : routeDecisionProgress(data);
    const policy = graph.routePolicy.nodes[node.id];
    const limitReached = execution.graph_visit_limit_exhausted && policy.fallback.kind === "route";

    if (policy.foremanProfile) {
      const foreman = await executeFactoryWorkflowForeman(admin, pin, {
        signal: options?.signal,
        freshIssueBlocker: decision
          ? "route_already_decided"
          : (execution.graph_route_blocker ??
            (limitReached ? workflowVisitLimitBlocker.code : undefined)),
      });
      if (decision) return foreman.foremanRunId ? { ...decision, foreman } : decision;
      if (foreman.status === "stale") return foreman;
      return { status: "foreman", foreman } as const;
    }

    if (decision) return decision;
    if (execution.graph_route_blocker)
      return { status: "blocked", code: execution.graph_route_blocker } as const;
    if (limitReached) return workflowVisitLimitBlocker;
    return { status: "pending", code: "route_proposal_required" } as const;
  }
  const nextEdge = graph.edges.find((edge) => edge.kind === "next" && edge.from === pin.nodeId);
  const admitNext: DeterministicWorkflowCommands["admitNext"] = async (args) => {
    const result = await admin.rpc("admit_factory_workflow_next", args).maybeSingle();
    if (result.error) {
      if (isWorkflowVisitLimitError(result.error)) return workflowVisitLimitBlocker;
      throw result.error;
    }
    return result.data ?? { status: "blocked", code: "evidence_stale" };
  };
  let stored = results.find((row) => row.occurrence_id === pin.occurrenceId);
  if (!stored && node.kind === "agent") {
    if (!graph.delegationPolicy || !Object.hasOwn(graph.delegationPolicy.targets, node.id))
      return { status: "blocked", code: "invalid_delegation_target" } as const;
    const { data, error } = await admin
      .rpc("record_factory_workflow_delegated_result", {
        ...scope,
        p_expected_generation: pin.p_expected_generation,
        p_ownership_token: pin.p_ownership_token,
        p_occurrence_id: occurrence.occurrence_id,
      })
      .maybeSingle();
    if (error) throw error;
    if (!data) return { status: "pending", code: "child_completion_pending" } as const;
    stored = {
      occurrence_id: occurrence.occurrence_id,
      result_id: data.result_id,
      outcome: "succeeded",
    };
  }
  if (stored) {
    const terminal = {
      status: "terminal" as const,
      resultId: stored.result_id,
      outcome: stored.outcome,
    };
    if (stored.outcome !== "succeeded" || !nextEdge) return terminal;
    const receipt = await admitNext({
      ...scope,
      p_expected_generation: pin.p_expected_generation,
      p_ownership_token: pin.p_ownership_token,
      p_source_occurrence_id: pin.occurrenceId,
      p_edge_id: nextEdge.id,
      p_expected_result_id: stored.result_id,
    });
    return "status" in receipt
      ? { ...terminal, successorBlocked: receipt.code }
      : {
          status: "admitted" as const,
          resultId: stored.result_id,
          transitionId: receipt.transition_id,
          targetOccurrenceId: receipt.target_occurrence_id,
          nextNodeId: nextEdge.to,
        };
  }
  if (node.kind === "review") {
    const { data, error } = await admin
      .rpc("read_factory_workflow_exact_review_progress", {
        ...scope,
        p_occurrence_id: occurrence.occurrence_id,
      })
      .abortSignal(options?.signal ?? AbortSignal.timeout(5_000));
    if (error) throw error;
    return z
      .object({
        status: z.enum(["pending", "blocked"]),
        code: z.enum([
          "exact_review_pending",
          "repair_pending",
          "repair_unsuccessful",
          "source_unavailable",
          "provider_unavailable",
          "invalid_report",
          "deadline",
          "generation_retired",
          "budget_exhausted",
          "stale_review",
          "finding_ineligible",
          "finding_repeated",
          "repair_budget_exhausted",
          "repair_stage_unavailable",
        ]),
      })
      .parse(data);
  }
  const rootInput = execution.graph_input_run_id
    ? { sessionId: pin.p_root_session_id, runId: execution.graph_input_run_id }
    : null;
  let input = rootInput;
  if (
    graph.nodes.some((candidate) => candidate.kind === "join") &&
    (node.kind === "human-gate" || (node.kind === "deterministic" && node.operation !== "policy"))
  ) {
    const { data, error } = await admin
      .rpc("read_factory_workflow_command_source", {
        ...scope,
        p_occurrence_id: occurrence.occurrence_id,
      })
      .maybeSingle();
    if (error) throw error;
    const observed = z
      .object({ session_id: z.string().uuid(), run_id: z.string().uuid() })
      .safeParse(data);
    input = observed.success
      ? { sessionId: observed.data.session_id, runId: observed.data.run_id }
      : null;
  }
  const sourceSessionId = input?.sessionId;
  const command = await loadCommandTarget(admin, node, pin, input);
  if (!command) return { status: "pending", code: "evidence_missing" } as const;
  if ("status" in command) return command;
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
    result: null,
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
    readCheckpointAdoption: (input) =>
      observeWorkflowCheckpoint({ admin, ...input, causalSessionId: sourceSessionId }),
    readHumanApproval: (input) =>
      observeWorkflowHumanApproval({ admin, ...input, causalSessionId: sourceSessionId }),
    readValidationEvidence: async ({ pin: current, target }) => {
      const checkpoint = await observeWorkflowCheckpoint({
        admin,
        pin: current,
        target,
        causalSessionId: sourceSessionId,
      });
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
