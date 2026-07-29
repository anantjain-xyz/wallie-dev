import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables, TablesInsert } from "@/lib/supabase/database.types";
import type { AgentProvider, SandboxConnection } from "@/lib/sandbox/types";

type AdminClient = SupabaseClient<Database>;

export const ACTIVE_AGENT_JOB_STATUSES = ["queued", "started", "running"] as const;
export const ACTIVE_AGENT_RUN_STATUSES = ["queued", "started", "running"] as const;
export const RECONCILABLE_SESSION_PHASES = [
  "agent_generating",
  "awaiting_review",
  "rejected",
] as const;

export async function claimSessionForGeneration(admin: AdminClient, sessionId: string) {
  const { data, error } = await admin
    .from("sessions")
    .update({ phase_status: "agent_generating" })
    .eq("id", sessionId)
    .in("phase_status", RECONCILABLE_SESSION_PHASES)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  return { claimed: Boolean(data), error };
}

export async function publishGeneratedArtifact(
  admin: AdminClient,
  input: { sessionId: string; version: number },
): Promise<boolean> {
  const { data, error } = await admin
    .from("sessions")
    .update({
      current_artifact_version: input.version,
      phase_status: "awaiting_review",
    })
    .eq("id", input.sessionId)
    .eq("phase_status", "agent_generating")
    .is("archived_at", null)
    .select("id");

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function restoreGeneratingSessionPhase(
  admin: AdminClient,
  input: { phaseStatus: Tables<"sessions">["phase_status"]; sessionId: string },
): Promise<void> {
  const { error } = await admin
    .from("sessions")
    .update({ phase_status: input.phaseStatus })
    .eq("id", input.sessionId)
    .eq("phase_status", "agent_generating");

  if (error) throw error;
}

export async function restorePublishedSessionAfterFailure(
  admin: AdminClient,
  input: {
    currentArtifactVersion: number;
    phaseStatus: Tables<"sessions">["phase_status"];
    sessionId: string;
  },
): Promise<void> {
  const { error } = await admin
    .from("sessions")
    .update({
      current_artifact_version: input.currentArtifactVersion,
      phase_status: input.phaseStatus,
    })
    .eq("id", input.sessionId)
    .eq("phase_status", "awaiting_review");

  if (error) throw error;
}

export async function claimSessionRejection(
  admin: AdminClient,
  input: {
    currentRejectionCount: number;
    expectedVersion: number;
    expectedWorkspaceId: string;
    sessionId: string;
  },
) {
  const nextRejectionCount = input.currentRejectionCount + 1;
  const { data, error } = await admin
    .from("sessions")
    .update({ rejection_count: nextRejectionCount })
    .eq("id", input.sessionId)
    .eq("workspace_id", input.expectedWorkspaceId)
    .eq("rejection_count", input.currentRejectionCount)
    .eq("phase_status", "awaiting_review")
    .eq("current_artifact_version", input.expectedVersion)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  return { claimed: Boolean(data), error, nextRejectionCount };
}

export async function publishRejectedSession(
  admin: AdminClient,
  input: {
    expectedRejectionCount: number;
    expectedVersion: number;
    expectedWorkspaceId: string;
    sessionId: string;
  },
) {
  const { data, error } = await admin
    .from("sessions")
    .update({ phase_status: "rejected" })
    .eq("id", input.sessionId)
    .eq("workspace_id", input.expectedWorkspaceId)
    .eq("rejection_count", input.expectedRejectionCount)
    .eq("phase_status", "awaiting_review")
    .eq("current_artifact_version", input.expectedVersion)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  return { error, published: Boolean(data) };
}

export async function archiveSessionMarker(admin: AdminClient, sessionId: string): Promise<void> {
  const { error } = await admin
    .from("sessions")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", sessionId)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  if (error) throw error;
}

export async function unarchiveSessionMarker(
  admin: AdminClient,
  input: { expectedArchivedAt?: string; sessionId: string },
): Promise<void> {
  let update = admin.from("sessions").update({ archived_at: null }).eq("id", input.sessionId);
  update = input.expectedArchivedAt
    ? update.eq("archived_at", input.expectedArchivedAt)
    : update.not("archived_at", "is", null);
  const { error } = await update.select("id").maybeSingle();

  if (error) throw error;
}

export async function parkCanceledSession(admin: AdminClient, sessionId: string): Promise<void> {
  const { error } = await admin
    .from("sessions")
    .update({ phase_status: "rejected" })
    .eq("id", sessionId)
    .eq("phase_status", "agent_generating");

  if (error) throw error;
}

export async function archiveSessionForReconciler(
  admin: AdminClient,
  sessionId: string,
): Promise<void> {
  const { error } = await admin
    .from("sessions")
    .update({ archived_at: new Date().toISOString(), phase_status: "rejected" })
    .eq("id", sessionId)
    .in("phase_status", RECONCILABLE_SESSION_PHASES);

  if (error) throw error;
}

export async function rerouteSessionForReconciler(
  admin: AdminClient,
  input: { sessionId: string; stageId: string },
): Promise<void> {
  const { error } = await admin
    .from("sessions")
    .update({
      archived_at: null,
      current_artifact_version: 0,
      current_stage_id: input.stageId,
      phase_status: "rejected",
      rejection_count: 0,
    })
    .eq("id", input.sessionId)
    .in("phase_status", RECONCILABLE_SESSION_PHASES);

  if (error) throw error;
}

export function parkStalledSession(admin: AdminClient, sessionId: string) {
  return admin
    .from("sessions")
    .update({ phase_status: "rejected" })
    .eq("id", sessionId)
    .eq("phase_status", "agent_generating");
}

export async function parkWorkspaceSessionsAfterDeleteFailure(
  admin: AdminClient,
  workspaceId: string,
) {
  return admin
    .from("sessions")
    .update({ phase_status: "rejected" })
    .eq("workspace_id", workspaceId)
    .eq("phase_status", "agent_generating");
}

export async function updateSessionTitleMetadata(
  admin: AdminClient,
  input: { sessionId: string; title: string; workspaceId: string },
) {
  return admin
    .from("sessions")
    .update({ title: input.title })
    .eq("id", input.sessionId)
    .eq("workspace_id", input.workspaceId)
    .select("id, title, updated_at")
    .single();
}

export async function insertSessionArtifact(
  admin: AdminClient,
  input: {
    artifactJson: string;
    sessionId: string;
    stageId: string;
    stageSlug: string;
    version: number;
    workspaceId: string;
  },
): Promise<void> {
  const { error } = await admin.from("session_artifacts").insert({
    artifact_json: input.artifactJson,
    session_id: input.sessionId,
    stage_id: input.stageId,
    stage_slug: input.stageSlug,
    version: input.version,
    workspace_id: input.workspaceId,
  });

  if (error) throw error;
}

export async function deleteSessionArtifactVersion(
  admin: AdminClient,
  input: { sessionId: string; stageSlug: string; version: number },
) {
  return admin
    .from("session_artifacts")
    .delete()
    .eq("session_id", input.sessionId)
    .eq("stage_slug", input.stageSlug)
    .eq("version", input.version);
}

export async function deleteSessionArtifactsForStages(
  admin: AdminClient,
  input: { sessionId: string; stageSlugs: readonly string[] },
) {
  return admin
    .from("session_artifacts")
    .delete()
    .eq("session_id", input.sessionId)
    .in("stage_slug", [...input.stageSlugs]);
}

export async function createQueuedAgentJob(
  admin: AdminClient,
  input: Omit<TablesInsert<"agent_jobs">, "status">,
) {
  return admin
    .from("agent_jobs")
    .insert({ ...input, status: "queued" })
    .select("id")
    .single();
}

export async function createQueuedAgentJobRecord(
  admin: AdminClient,
  input: Omit<TablesInsert<"agent_jobs">, "status">,
) {
  return admin
    .from("agent_jobs")
    .insert({ ...input, status: "queued" })
    .select("*")
    .single();
}

export async function enqueueQueuedAgentJob(
  admin: AdminClient,
  input: Omit<TablesInsert<"agent_jobs">, "status">,
) {
  return admin.from("agent_jobs").insert({ ...input, status: "queued" });
}

export async function deleteQueuedAgentJob(admin: AdminClient, jobId: string) {
  return admin.from("agent_jobs").delete().eq("id", jobId).eq("status", "queued");
}

export async function claimQueuedAgentJob(
  admin: AdminClient,
  input: { attemptCount: number; jobId: string; startedAt: string | null },
) {
  return admin
    .from("agent_jobs")
    .update({
      attempt_count: input.attemptCount + 1,
      last_error: null,
      started_at: input.startedAt ?? new Date().toISOString(),
      status: "running",
    })
    .eq("id", input.jobId)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();
}

export async function completeAgentJob(
  admin: AdminClient,
  input: { errorMessage?: string; jobId: string; status: "error" | "success" },
) {
  return admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      ...(input.errorMessage === undefined ? {} : { last_error: input.errorMessage }),
      status: input.status,
    })
    .eq("id", input.jobId)
    .neq("status", "canceled");
}

export async function errorRunningAgentJob(
  admin: AdminClient,
  input: { errorMessage: string; jobId: string },
) {
  return admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      last_error: input.errorMessage,
      status: "error",
    })
    .eq("id", input.jobId)
    .eq("status", "running");
}

export async function recordAgentJobError(
  admin: AdminClient,
  input: { errorMessage: string; jobId: string },
) {
  return admin.from("agent_jobs").update({ last_error: input.errorMessage }).eq("id", input.jobId);
}

export async function cancelSessionAgentJobs(
  admin: AdminClient,
  input: { finishedAt: string; reason: string; sessionId: string },
) {
  return admin
    .from("agent_jobs")
    .update({
      finished_at: input.finishedAt,
      last_error: input.reason,
      status: "canceled",
    })
    .eq("session_id", input.sessionId)
    .in("status", ACTIVE_AGENT_JOB_STATUSES)
    .select("id");
}

export async function cancelWorkspaceAgentJobs(
  admin: AdminClient,
  input: { finishedAt: string; reason: string; workspaceId: string },
) {
  return admin
    .from("agent_jobs")
    .update({
      finished_at: input.finishedAt,
      last_error: input.reason,
      status: "canceled",
    })
    .eq("workspace_id", input.workspaceId)
    .in("status", ACTIVE_AGENT_JOB_STATUSES)
    .select("id");
}

export async function scheduleAgentJobRetry(
  admin: AdminClient,
  input: { baseDelayMs: number; jobId: string; maxBackoffMs: number },
) {
  return admin.rpc("schedule_job_retry", {
    target_job_id: input.jobId,
    base_delay_ms: input.baseDelayMs,
    max_backoff_ms: input.maxBackoffMs,
  });
}

export async function claimNextAgentJob(admin: AdminClient, defaultConcurrencyLimit: number) {
  return admin.rpc("claim_next_agent_job", {
    default_concurrency_limit: defaultConcurrencyLimit,
  });
}

export async function approveSessionStage(
  admin: AdminClient,
  input: {
    approverMemberId: string | null;
    expectedVersion: number;
    expectedWorkspaceId: string;
    sessionId: string;
  },
) {
  return admin.rpc("approve_session_stage", {
    approver_member_id: input.approverMemberId ?? undefined,
    expected_version: input.expectedVersion,
    expected_workspace_id: input.expectedWorkspaceId,
    target_session_id: input.sessionId,
  });
}

export async function createSessionWithFirstJobTransition(
  admin: AdminClient,
  input: {
    creatorMemberId: string;
    githubRepositoryId: string | null;
    linearIssueId: string | null;
    linearIssueUrl: string | null;
    modelName: string;
    modelProvider: string;
    pipelineId?: string | null;
    promptMd: string;
    title: string;
    workspaceId: string;
  },
) {
  return admin
    .rpc("create_session_with_first_job", {
      agent_model_name: input.modelName,
      agent_model_provider: input.modelProvider,
      creator_member_id: input.creatorMemberId,
      selected_pipeline_id: input.pipelineId ?? undefined,
      session_github_repository_id: input.githubRepositoryId ?? undefined,
      session_linear_issue_id: input.linearIssueId ?? undefined,
      session_linear_issue_url: input.linearIssueUrl ?? undefined,
      session_prompt_md: input.promptMd,
      session_title: input.title,
      target_workspace_id: input.workspaceId,
    })
    .single();
}

export async function createQueuedAgentRun(
  admin: AdminClient,
  input: Omit<TablesInsert<"agent_runs">, "status">,
) {
  return admin
    .from("agent_runs")
    .insert({ ...input, status: "queued" })
    .select("*")
    .single();
}

export async function enqueueQueuedAgentRun(
  admin: AdminClient,
  input: Omit<TablesInsert<"agent_runs">, "status">,
) {
  return admin.from("agent_runs").insert({ ...input, status: "queued" });
}

export async function startAgentRun(
  admin: AdminClient,
  input: {
    jobId: string;
    model: string;
    provider: AgentProvider;
    requestedByMemberId: string | null;
    runType: string;
    sessionId: string;
    stage: { id: string; name: string; slug: string } | null;
    workspaceId: string;
  },
): Promise<string | null> {
  const startedAt = new Date().toISOString();
  const { data: existingRun, error: updateError } = await admin
    .from("agent_runs")
    .update({
      model_name: input.model,
      model_provider: input.provider,
      stage_id: input.stage?.id ?? null,
      stage_name: input.stage?.name ?? null,
      stage_slug: input.stage?.slug ?? null,
      started_at: startedAt,
      status: "running",
      triggered_by_member_id: input.requestedByMemberId,
    })
    .eq("agent_job_id", input.jobId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select("id")
    .maybeSingle();

  if (updateError) throw updateError;
  if (existingRun) return existingRun.id;

  const { data, error } = await admin
    .from("agent_runs")
    .insert({
      agent_job_id: input.jobId,
      model_name: input.model,
      model_provider: input.provider,
      run_type: input.runType,
      session_id: input.sessionId,
      stage_id: input.stage?.id ?? null,
      stage_name: input.stage?.name ?? null,
      stage_slug: input.stage?.slug ?? null,
      started_at: startedAt,
      status: "running",
      triggered_by_member_id: input.requestedByMemberId,
      workspace_id: input.workspaceId,
    })
    .select("id")
    .single();

  if (error || !data) return null;
  return data.id;
}

export async function attachRunSandbox(
  admin: AdminClient,
  input: {
    metadata:
      | { provider: "fake" }
      | { connection: SandboxConnection; provider: "daytona" | "e2b" | "vercel" };
    runId: string;
    sandboxId: string;
  },
): Promise<boolean> {
  const vercelMetadata =
    input.metadata.provider === "vercel" && input.metadata.connection.provider === "vercel"
      ? {
          sandbox_vercel_project_id: input.metadata.connection.credentials.projectId,
          sandbox_vercel_team_id: input.metadata.connection.credentials.teamId,
        }
      : {
          sandbox_vercel_project_id: null,
          sandbox_vercel_team_id: null,
        };
  const { data, error } = await admin
    .from("agent_runs")
    .update({
      sandbox_connection_revision:
        input.metadata.provider === "fake" ? null : input.metadata.connection.revision,
      sandbox_id: input.sandboxId,
      sandbox_provider: input.metadata.provider,
      ...vercelMetadata,
    })
    .eq("id", input.runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select("id");

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function completeAgentRun(
  admin: AdminClient,
  input: {
    runId: string;
    status: "error" | "success";
    usage?: { inputTokens: number; outputTokens: number };
  },
) {
  return admin
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: input.status,
      ...(input.usage
        ? {
            input_tokens: input.usage.inputTokens,
            output_tokens: input.usage.outputTokens,
          }
        : {}),
    })
    .eq("id", input.runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
}

export async function cancelActiveRunsForJob(admin: AdminClient, jobId: string) {
  return admin
    .from("agent_runs")
    .update({ finished_at: new Date().toISOString(), status: "canceled" })
    .eq("agent_job_id", jobId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
}

export async function errorActiveRunsForJob(admin: AdminClient, jobId: string) {
  return admin
    .from("agent_runs")
    .update({ finished_at: new Date().toISOString(), status: "error" })
    .eq("agent_job_id", jobId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
}

export async function touchActiveRun(admin: AdminClient, runId: string) {
  return admin
    .from("agent_runs")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
}

export async function touchActiveRunsForJob(admin: AdminClient, jobId: string) {
  return admin
    .from("agent_runs")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("agent_job_id", jobId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
}

export async function errorStalledRun(admin: AdminClient, runId: string) {
  return admin
    .from("agent_runs")
    .update({ finished_at: new Date().toISOString(), status: "error" })
    .eq("id", runId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES);
}

export async function cancelSessionAgentRuns(
  admin: AdminClient,
  input: { finishedAt: string; sessionId: string },
) {
  return admin
    .from("agent_runs")
    .update({ finished_at: input.finishedAt, status: "canceled" })
    .eq("session_id", input.sessionId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select(
      "id, workspace_id, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id",
    );
}

export async function cancelWorkspaceAgentRuns(
  admin: AdminClient,
  input: { finishedAt: string; workspaceId: string },
) {
  return admin
    .from("agent_runs")
    .update({ finished_at: input.finishedAt, status: "canceled" })
    .eq("workspace_id", input.workspaceId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select(
      "id, workspace_id, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id",
    );
}
