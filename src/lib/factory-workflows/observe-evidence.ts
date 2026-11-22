import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { isWallieCheckpointRef } from "@/lib/checkpoint-ref";
import { loadPinnedFactoryExecution } from "@/lib/factory-definitions/runtime-definition";
import type { Database, Tables } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;
type WorkflowFunctions = Database["public"]["Functions"];
type RootScope = WorkflowFunctions["read_factory_workflow_execution"]["Args"];
type ObservationPin = Readonly<
  RootScope &
    Pick<
      WorkflowFunctions["record_factory_workflow_node_result"]["Args"],
      "p_expected_generation" | "p_ownership_token"
    >
>;
type RunTarget = {
  sessionId: string;
  jobId: string;
  attemptCount: number;
  runId: string;
  repositoryId: string;
  commitSha: string;
};
type GateTarget = {
  sessionId: string;
  stageId: string;
  artifactId: string;
  artifactVersion: number;
  artifactDigest: string;
  anyoneCanApprove: boolean;
  approverMemberIds: readonly string[];
};
type ObserverInput<Target> = {
  admin: Admin;
  // Supplied by the worker handoff. The SQL command compares ownership
  // separately when recording or admitting a result.
  pin: ObservationPin;
  target: Target;
  signal?: AbortSignal;
};
type AttemptRow = Pick<
  Tables<"session_git_checkpoints">,
  "workspace_id" | "session_id" | "run_id" | "job_id" | "attempt_count"
>;

type CheckpointObservation =
  | { status: "pending"; code: "checkpoint_pending"; recoverableRunId?: string }
  | { status: "blocked"; code: "checkpoint_unavailable" }
  | {
      status: "passed";
      receiptRef: string;
      artifactId: string;
      commitSha: string;
      retainedRef: string | null;
    };

type HumanApprovalObservation =
  | { status: "pending"; code: "approval_pending" }
  | { status: "blocked"; code: "approval_blocked" }
  | { status: "passed"; receiptRef: string; completionId: string; artifactDigest: string };

function matchesAttempt(row: AttemptRow, scope: RootScope, target: RunTarget) {
  return (
    row.workspace_id === scope.p_workspace_id &&
    row.session_id === target.sessionId &&
    row.job_id === target.jobId &&
    row.attempt_count === target.attemptCount &&
    row.run_id === target.runId
  );
}

async function loadRootSession(admin: Admin, scope: RootScope, signal: AbortSignal) {
  const { data, error } = await admin
    .from("sessions")
    .select(
      "id, workspace_id, factory_id, factory_definition_revision_id, execute_pinned_definition, archived_at, phase_status, current_stage_id, current_artifact_id, current_artifact_version",
    )
    .eq("id", scope.p_root_session_id)
    .eq("workspace_id", scope.p_workspace_id)
    .eq("factory_id", scope.p_factory_id)
    .abortSignal(signal)
    .maybeSingle();
  if (error) throw error;
  if (
    data?.id !== scope.p_root_session_id ||
    data.workspace_id !== scope.p_workspace_id ||
    data.factory_id !== scope.p_factory_id ||
    (data.archived_at && data.phase_status !== "approved")
  )
    return null;
  return data;
}

/** Consume the exact durable intent and the GitHub proof recorded by the adoption transaction. */
export async function observeWorkflowCheckpoint({
  admin,
  pin,
  target,
  signal = AbortSignal.timeout(5_000),
}: ObserverInput<RunTarget>): Promise<CheckpointObservation> {
  const blocked = { status: "blocked", code: "checkpoint_unavailable" } as const;
  if (target.sessionId !== pin.p_root_session_id) return blocked;
  try {
    const session = await loadRootSession(admin, pin, signal);
    if (!session) return blocked;
    const { data: publication, error } = await admin
      .from("session_checkpoint_publications")
      .select(
        "run_id, workspace_id, session_id, job_id, attempt_count, status, deadline_at, retained_ref, remote_verified_ref, remote_verified_sha, remote_verified_at, artifact_id, adopted_at",
      )
      .eq("run_id", target.runId)
      .eq("workspace_id", pin.p_workspace_id)
      .eq("session_id", target.sessionId)
      .abortSignal(signal)
      .maybeSingle();
    if (error) return blocked;
    if (!publication) return { status: "pending", code: "checkpoint_pending" };
    if (!matchesAttempt(publication, pin, target)) return blocked;
    if (publication.status === "stale") return blocked;

    const { data: source, error: sourceError } = await admin
      .from("session_source_deliveries")
      .select(
        "run_id, workspace_id, session_id, job_id, attempt_count, repository_id, repository_full_name, base_sha, head_sha",
      )
      .eq("run_id", target.runId)
      .eq("workspace_id", pin.p_workspace_id)
      .eq("session_id", target.sessionId)
      .abortSignal(signal)
      .maybeSingle();
    if (
      sourceError ||
      !source ||
      !matchesAttempt(source, pin, target) ||
      source.repository_id !== target.repositoryId ||
      source.head_sha !== target.commitSha
    )
      return blocked;

    const codeOutput = source.base_sha !== source.head_sha;
    const ref = publication.retained_ref;
    if (
      codeOutput
        ? !ref || !isWallieCheckpointRef(ref, target.commitSha, target.runId)
        : ref !== null
    )
      return blocked;

    if (publication.status === "pending" || publication.status === "claimed") {
      if (session.archived_at || !(Date.parse(publication.deadline_at) > Date.now()))
        return blocked;
      // The existing publication maintenance may claim just this run. It owns
      // the external write, deadline, lease and remote verification.
      return { status: "pending", code: "checkpoint_pending", recoverableRunId: target.runId };
    }
    if (publication.status !== "adopted" || !publication.artifact_id || !publication.adopted_at)
      return blocked;
    if (
      codeOutput
        ? publication.remote_verified_ref !== ref ||
          publication.remote_verified_sha !== source.head_sha ||
          publication.remote_verified_at === null
        : publication.remote_verified_ref !== null ||
          publication.remote_verified_sha !== null ||
          publication.remote_verified_at !== null
    )
      return blocked;

    const { data: checkpoint, error: checkpointError } = await admin
      .from("session_git_checkpoints")
      .select(
        "run_id, workspace_id, session_id, job_id, attempt_count, repository_id, repository_full_name, input_sha, output_kind, output_sha, output_ref, artifact_id",
      )
      .eq("run_id", target.runId)
      .eq("workspace_id", pin.p_workspace_id)
      .eq("session_id", target.sessionId)
      .abortSignal(signal)
      .maybeSingle();
    if (
      checkpointError ||
      !checkpoint ||
      !matchesAttempt(checkpoint, pin, target) ||
      checkpoint.repository_id !== source.repository_id ||
      checkpoint.repository_full_name !== source.repository_full_name ||
      checkpoint.input_sha !== source.base_sha ||
      checkpoint.output_sha !== source.head_sha ||
      checkpoint.output_kind !== (codeOutput ? "code" : "no-code") ||
      checkpoint.output_ref !== ref ||
      checkpoint.artifact_id !== publication.artifact_id
    )
      return blocked;

    return {
      status: "passed",
      receiptRef: publication.run_id,
      artifactId: publication.artifact_id,
      commitSha: checkpoint.output_sha,
      retainedRef: ref,
    };
  } catch {
    return blocked;
  }
}

function sameApproverPolicy(
  left: GateTarget,
  right: Pick<GateTarget, "anyoneCanApprove" | "approverMemberIds">,
) {
  const effectiveApprovers = new Set(left.approverMemberIds.map((id) => id.toLowerCase()));
  const pinnedApprovers = new Set(right.approverMemberIds.map((id) => id.toLowerCase()));
  return (
    left.anyoneCanApprove === right.anyoneCanApprove &&
    effectiveApprovers.size === pinnedApprovers.size &&
    [...effectiveApprovers].every((id) => pinnedApprovers.has(id))
  );
}

/** Observe the latest exact human approval on a completion that still counts. */
export async function observeWorkflowHumanApproval({
  admin,
  pin,
  target,
  signal = AbortSignal.timeout(5_000),
}: ObserverInput<GateTarget>): Promise<HumanApprovalObservation> {
  const blocked = { status: "blocked", code: "approval_blocked" } as const;
  if (target.sessionId !== pin.p_root_session_id) return blocked;
  try {
    const session = await loadRootSession(admin, pin, signal);
    if (!session) return blocked;
    const definition = await loadPinnedFactoryExecution(admin, session);
    if (!definition) return blocked;
    const position = definition.stages.findIndex(({ id }) => id === target.stageId);
    const currentPosition = definition.stages.findIndex(
      ({ id }) => id === session.current_stage_id,
    );
    if (
      position < 0 ||
      position > currentPosition ||
      !sameApproverPolicy(target, definition.stages[position])
    )
      return blocked;
    const awaitingReview =
      position === currentPosition && session.phase_status === "awaiting_review";
    if (position === currentPosition) {
      if (
        session.current_artifact_id !== target.artifactId ||
        session.current_artifact_version !== target.artifactVersion
      )
        return blocked;
      // Final approval keeps its stage selected even after progression.
      if (!awaitingReview && session.phase_status !== "approved") return blocked;
    }

    const [completionResult, artifactResult, blockingResult] = await Promise.all([
      admin
        .from("session_phase_completions")
        .select("id, workspace_id, session_id, stage_id")
        .eq("workspace_id", pin.p_workspace_id)
        .eq("session_id", target.sessionId)
        .eq("stage_id", target.stageId)
        .order("completed_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .abortSignal(signal)
        .maybeSingle(),
      admin
        .from("session_artifacts")
        .select(
          "id, workspace_id, session_id, stage_id, version, artifact_json, canonical:artifact_json::text",
        )
        .eq("workspace_id", pin.p_workspace_id)
        .eq("session_id", target.sessionId)
        .eq("stage_id", target.stageId)
        .eq("id", target.artifactId)
        .eq("version", target.artifactVersion)
        .abortSignal(signal)
        .maybeSingle(),
      admin
        .from("artifact_review_threads")
        .select("id")
        .eq("workspace_id", pin.p_workspace_id)
        .eq("session_id", target.sessionId)
        .eq("kind", "blocking")
        .eq("status", "open")
        .limit(1)
        .abortSignal(signal)
        .maybeSingle(),
    ]);
    const completion = completionResult.data;
    const artifact = artifactResult.data;
    if (
      completionResult.error ||
      artifactResult.error ||
      blockingResult.error ||
      blockingResult.data ||
      !artifact ||
      artifact.workspace_id !== pin.p_workspace_id ||
      artifact.session_id !== target.sessionId ||
      artifact.stage_id !== target.stageId ||
      artifact.id !== target.artifactId ||
      artifact.version !== target.artifactVersion
    )
      return blocked;

    // Stored approvals hash markdown bytes or PostgreSQL's JSONB text for
    // older artifacts. Never reserialize a JSON artifact in the worker.
    const text =
      typeof artifact.artifact_json === "string" ? artifact.artifact_json : artifact.canonical;
    if (
      typeof text !== "string" ||
      createHash("sha256").update(text, "utf8").digest("hex") !== target.artifactDigest
    )
      return blocked;
    if (awaitingReview) return { status: "pending", code: "approval_pending" };
    if (
      !completion ||
      completion.workspace_id !== pin.p_workspace_id ||
      completion.session_id !== target.sessionId ||
      completion.stage_id !== target.stageId
    )
      return blocked;

    const { data: approval, error } = await admin
      .from("session_stage_approval_receipts")
      .select(
        "id, workspace_id, session_id, stage_id, completion_id, artifact_id, artifact_version, artifact_digest",
      )
      .eq("workspace_id", pin.p_workspace_id)
      .eq("session_id", target.sessionId)
      .eq("stage_id", target.stageId)
      .eq("completion_id", completion.id)
      .order("approval_number", { ascending: false })
      .limit(1)
      .abortSignal(signal)
      .maybeSingle();
    if (
      error ||
      !approval ||
      approval.workspace_id !== pin.p_workspace_id ||
      approval.session_id !== target.sessionId ||
      approval.stage_id !== target.stageId ||
      approval.completion_id !== completion.id ||
      approval.artifact_id !== target.artifactId ||
      approval.artifact_version !== target.artifactVersion ||
      approval.artifact_digest !== target.artifactDigest
    )
      return blocked;

    return {
      status: "passed",
      receiptRef: approval.id,
      completionId: completion.id,
      artifactDigest: approval.artifact_digest,
    };
  } catch {
    return blocked;
  }
}
