import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Enums, Tables } from "@/lib/supabase/database.types";
import { resolveEffectiveSessionRepository } from "@/features/sessions/effective-repository";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  cancelSessionWork,
  isActiveAgentRunStatus,
} from "@/lib/pipeline/cancel";
import {
  buildWallieBlockingReasons,
  inferWallieRunMode,
  parseWallieRunMode,
} from "@/features/wallie/utils";
import type {
  WallieActionErrorCode,
  WallieBlockingReason,
  WallieSessionRepository,
  WallieRunMode,
  WallieVercelSandboxConnectionStatus,
} from "@/features/wallie/types";
import { loadWorkspaceAgentConfig } from "@/lib/agent-runner";
import { resolveSandboxImplementation } from "@/lib/sandbox";
import {
  assertCurrentSandboxCapabilityCheck,
  SandboxCapabilityCheckStaleError,
} from "@/lib/sandbox-capabilities/readiness";
import { loadWorkspaceSandboxOverview, providerLabel } from "@/lib/sandbox-connections/server";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;
type WorkspaceAccessWorkspace = Pick<Tables<"workspaces">, "id" | "name" | "slug">;
type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type SessionForRun = Pick<
  Tables<"sessions">,
  | "archived_at"
  | "created_at"
  | "current_stage_id"
  | "id"
  | "number"
  | "phase_status"
  | "prompt_md"
  | "title"
  | "workspace_id"
>;
type AgentRunRow = Tables<"agent_runs">;
type SessionForEnqueue = Pick<Tables<"sessions">, "current_stage_id" | "id" | "workspace_id">;

const sessionSelect =
  "id, workspace_id, number, title, prompt_md, current_stage_id, created_at, archived_at, phase_status";
const runSelect =
  "id, workspace_id, session_id, agent_job_id, triggered_by_member_id, run_type, stage_id, stage_slug, stage_name, model_provider, model_name, status, started_at, finished_at, last_activity_at, input_tokens, output_tokens, total_cost_usd, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id, created_at, updated_at";
export class WallieActionError extends Error {
  readonly code: WallieActionErrorCode;
  readonly provider?: "vercel" | "e2b" | "daytona";
  readonly statusCode: number;

  constructor(input: {
    code: WallieActionErrorCode;
    message: string;
    provider?: "vercel" | "e2b" | "daytona";
    statusCode: number;
  }) {
    super(input.message);
    this.code = input.code;
    this.name = "WallieActionError";
    this.provider = input.provider;
    this.statusCode = input.statusCode;
  }
}

export type EnqueueWallieRunResult = {
  created: boolean;
  jobId: string | null;
  /** The accepted job may be waiting for its worker to create an active run. */
  run: AgentRunRow | null;
};

export type EnqueueSessionJobWithRunInput = {
  admin: AdminClient;
  requestedByMemberId: string | null;
  /**
   * Mode stamped on the queued run. Defaults to the mode inferred from the
   * session's effective repository — the same resolution the processor
   * performs at run time.
   */
  runType?: WallieRunMode;
  session: SessionForEnqueue;
  triggerType: Enums<"agent_trigger_type">;
};

export type CreateSessionWithFirstJobResult = {
  jobId: string;
  number: number;
  runId: string;
  sessionId: string;
  workspaceSlug: string;
};

function toBlockingActionError(reasons: WallieBlockingReason[]) {
  const blockingReason = reasons.find((reason) => reason.code !== "active_run");

  if (!blockingReason) {
    return null;
  }

  return new WallieActionError({
    code: blockingReason.code,
    message: reasons.map((reason) => reason.message).join(" "),
    provider: blockingReason.provider,
    statusCode: 422,
  });
}

export type SessionFirstRunPrerequisites = {
  agentConfig: Awaited<ReturnType<typeof loadWorkspaceAgentConfig>>;
  vercelSandboxConnection: WallieVercelSandboxConnectionStatus;
};

export async function loadSessionFirstRunPrerequisites(input: {
  admin?: AdminClient;
  workspaceId: string;
}): Promise<SessionFirstRunPrerequisites> {
  const admin = input.admin ?? createSupabaseAdminClient();
  const [agentConfig, vercelSandboxConnection] = await Promise.all([
    loadWorkspaceAgentConfig(admin, input.workspaceId),
    loadWallieVercelSandboxConnection(admin, input.workspaceId),
  ]);

  return { agentConfig, vercelSandboxConnection };
}

export function assertSessionFirstRunReady(input: {
  agentConfig: SessionFirstRunPrerequisites["agentConfig"];
  repository: WallieSessionRepository | null;
  vercelSandboxConnection: WallieVercelSandboxConnectionStatus;
}) {
  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: false,
    mode: inferWallieRunMode(input.repository?.id ?? null),
    repository: input.repository,
    requiresVercelSandbox: resolveSandboxImplementation() !== "fake",
    vercelSandboxConnection: input.vercelSandboxConnection,
  });
  const blockingError = toBlockingActionError(blockingReasons);

  if (blockingError) {
    throw blockingError;
  }

  return input.agentConfig;
}

export async function assertSessionSandboxCapabilityReady(input: {
  admin?: AdminClient;
  agentConfig: SessionFirstRunPrerequisites["agentConfig"];
  repository: WallieSessionRepository | null;
  sandboxConnection: WallieVercelSandboxConnectionStatus;
  workspaceId: string;
}): Promise<void> {
  if (resolveSandboxImplementation() === "fake" || !input.repository) return;

  const provider = input.sandboxConnection.provider ?? "vercel";
  const revision = input.sandboxConnection.connectionRevision;
  if (!revision) {
    throw new WallieActionError({
      code: "sandbox_capability_check_stale",
      message: `Run a successful ${input.sandboxConnection.providerLabel ?? "sandbox provider"} capability check before starting Wallie.`,
      provider,
      statusCode: 422,
    });
  }

  try {
    await assertCurrentSandboxCapabilityCheck({
      admin: input.admin ?? createSupabaseAdminClient(),
      agent: input.agentConfig,
      connection: { provider, revision },
      repositoryId: input.repository.id,
      workspaceId: input.workspaceId,
    });
  } catch (error) {
    if (!(error instanceof SandboxCapabilityCheckStaleError)) throw error;
    throw new WallieActionError({
      code: "sandbox_capability_check_stale",
      message: error.message,
      provider: error.provider,
      statusCode: 422,
    });
  }
}

export async function createSessionWithFirstJob(input: {
  admin?: AdminClient;
  attachmentIds?: string[];
  creationRequest?: { id: string; fingerprint: string };
  creatorMemberId: string;
  githubRepositoryId: string | null;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  modelName: string;
  modelProvider: string;
  pipelineId?: string | null;
  promptMd: string;
  selectedStageIds?: string[];
  title: string;
  workspaceId: string;
}): Promise<CreateSessionWithFirstJobResult> {
  const admin = input.admin ?? createSupabaseAdminClient();
  const args = {
    agent_model_name: input.modelName,
    agent_model_provider: input.modelProvider,
    creator_member_id: input.creatorMemberId,
    selected_pipeline_id: input.pipelineId ?? undefined,
    selected_stage_ids: input.selectedStageIds,
    session_attachment_ids: input.attachmentIds ?? [],
    session_github_repository_id: input.githubRepositoryId ?? undefined,
    session_linear_issue_id: input.linearIssueId ?? undefined,
    session_linear_issue_url: input.linearIssueUrl ?? undefined,
    session_prompt_md: input.promptMd,
    session_title: input.title,
    target_workspace_id: input.workspaceId,
  };
  const query = input.creationRequest
    ? admin.rpc("create_session_once_with_first_job", {
        ...args,
        target_request_id: input.creationRequest.id,
        target_request_hash: input.creationRequest.fingerprint,
      })
    : admin.rpc("create_session_with_first_job_and_attachments", args);
  const { data, error } = await query.single();

  if (error || !data) {
    throw error ?? new Error("Wallie could not create that session.");
  }

  return {
    jobId: data.job_id,
    number: data.session_number,
    runId: data.run_id,
    sessionId: data.session_id,
    workspaceSlug: data.workspace_slug,
  };
}

/** Replay before external preflight: a committed request remains successful. */
export async function findSessionCreationRequest(input: {
  admin: AdminClient;
  creationRequest: { id: string; fingerprint: string };
  creatorMemberId: string;
  workspaceId: string;
}): Promise<CreateSessionWithFirstJobResult | null> {
  const { data, error } = await input.admin
    .rpc("find_session_creation_request", {
      target_workspace_id: input.workspaceId,
      creator_member_id: input.creatorMemberId,
      target_request_id: input.creationRequest.id,
      target_request_hash: input.creationRequest.fingerprint,
    })
    .maybeSingle();
  if (error) throw error;
  return data
    ? {
        jobId: data.job_id,
        number: data.session_number,
        runId: data.run_id,
        sessionId: data.session_id,
        workspaceSlug: data.workspace_slug,
      }
    : null;
}

async function loadSessionForRun(
  supabase: SupabaseServerClient,
  sessionId: string | null,
  workspaceId: string,
): Promise<SessionForRun | null> {
  if (!sessionId) return null;

  const { data, error } = await supabase
    .from("sessions")
    .select(sessionSelect)
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  return data as SessionForRun;
}

async function loadWallieVercelSandboxConnection(
  admin: AdminClient,
  workspaceId: string,
): Promise<WallieVercelSandboxConnectionStatus> {
  const overview = await loadWorkspaceSandboxOverview(admin, workspaceId);
  const provider = overview.activeProvider;
  const connection = overview.connections[provider];

  if (!overview.enabledProviders.includes(provider)) {
    return {
      connected: false,
      connectionRevision: connection ? String(connection.connectionRevision) : null,
      displayName: null,
      lastValidationError: `${providerLabel(provider)} is disabled in this Wallie deployment. Switch to an enabled sandbox provider.`,
      provider,
      providerLabel: providerLabel(provider),
      projectId: null,
      projectName: null,
      status: "error",
      teamId: null,
    };
  }

  if (!connection) {
    return {
      connected: false,
      connectionRevision: null,
      displayName: null,
      lastValidationError: null,
      provider,
      providerLabel: providerLabel(provider),
      projectId: null,
      projectName: null,
      status: "missing",
      teamId: null,
    };
  }

  const vercel = provider === "vercel" ? overview.connections.vercel : null;
  const displayName =
    provider === "vercel"
      ? (vercel?.projectName ?? vercel?.projectId ?? null)
      : provider === "e2b"
        ? (overview.connections.e2b?.apiKeyPreview ?? null)
        : (overview.connections.daytona?.target ?? overview.connections.daytona?.apiUrl ?? null);
  return {
    connected: connection.status === "connected",
    connectionRevision: String(connection.connectionRevision),
    displayName,
    lastValidationError: connection.lastValidationError,
    provider,
    providerLabel: providerLabel(provider),
    projectId: vercel?.projectId ?? null,
    projectName: vercel?.projectName ?? null,
    status: connection.status,
    teamId: vercel?.teamId ?? null,
  };
}

async function loadActiveRunForSession(admin: AdminClient, sessionId: string) {
  const { data, error } = await admin
    .from("agent_runs")
    .select(runSelect)
    .eq("session_id", sessionId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as AgentRunRow | null;
}

async function loadRunById(admin: AdminClient, runId: string) {
  const { data, error } = await admin
    .from("agent_runs")
    .select(runSelect)
    .eq("id", runId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data as AgentRunRow | null;
}

async function validateQueuedRunRequest(input: {
  admin: AdminClient;
  sessionId: string | null;
  requestedRunType: WallieRunMode;
  supabase: SupabaseServerClient;
  workspace: WorkspaceAccessWorkspace;
}) {
  const session = await loadSessionForRun(input.supabase, input.sessionId, input.workspace.id);

  if (!session) {
    throw new WallieActionError({
      code: "session_not_found",
      message: "Session not found.",
      statusCode: 404,
    });
  }

  // An archived session accepts no new work. This keeps the retry path from
  // resurrecting work that archive just canceled.
  if (session.archived_at) {
    throw new WallieActionError({
      code: "session_archived",
      message: "This session is archived. Unarchive it to run Wallie.",
      statusCode: 409,
    });
  }

  // A completed session sits in `approved` (terminal-stage approval leaves it
  // there). The processor only claims in_progress/awaiting_review/rejected,
  // so enqueueing here would strand a queued run the worker never finishes.
  // Reject up front — this also covers a completed session that was unarchived.
  if (session.phase_status === "approved") {
    throw new WallieActionError({
      code: "session_not_runnable",
      message: "This session is complete. There is nothing left to run.",
      statusCode: 409,
    });
  }

  const workspace = input.workspace;
  const [repositoryResolution, activeRun, vercelSandboxConnection] = await Promise.all([
    resolveEffectiveSessionRepository({
      sessionId: session.id,
      supabase: input.admin,
      workspaceId: workspace.id,
    }),
    loadActiveRunForSession(input.admin, session.id),
    loadWallieVercelSandboxConnection(input.admin, workspace.id),
  ]);
  const repository: WallieSessionRepository | null = repositoryResolution.repository
    ? {
        defaultBranch: repositoryResolution.repository.defaultBranch,
        defaultProgrammingLanguage: repositoryResolution.repository.defaultProgrammingLanguage,
        fullName: repositoryResolution.repository.fullName,
        htmlUrl: repositoryResolution.repository.htmlUrl,
        id: repositoryResolution.repository.id,
        isArchived: repositoryResolution.repository.isArchived,
        isPrivate: repositoryResolution.repository.isPrivate,
      }
    : null;
  const runType = input.requestedRunType;

  if (activeRun) {
    return {
      activeRun,
      session,
      repository,
      runType,
      workspace,
    };
  }

  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: false,
    mode: runType,
    repository,
    requiresVercelSandbox: resolveSandboxImplementation() !== "fake",
    vercelSandboxConnection,
  });
  const blockingError = toBlockingActionError(blockingReasons);

  if (blockingError) {
    throw blockingError;
  }

  const agentConfig = await loadWorkspaceAgentConfig(input.admin, workspace.id);
  await assertSessionSandboxCapabilityReady({
    admin: input.admin,
    agentConfig,
    repository,
    sandboxConnection: vercelSandboxConnection,
    workspaceId: workspace.id,
  });

  return {
    activeRun,
    session,
    repository,
    runType,
    workspace,
  };
}

async function inferSessionRunType(
  admin: AdminClient,
  session: Pick<SessionForEnqueue, "id" | "workspace_id">,
): Promise<WallieRunMode> {
  const resolution = await resolveEffectiveSessionRepository({
    sessionId: session.id,
    supabase: admin,
    workspaceId: session.workspace_id,
  });
  return inferWallieRunMode(resolution.repositoryId);
}

export type QueuedRunConfig = {
  modelName: string;
  modelProvider: string;
  runType: WallieRunMode;
};

/**
 * Model and run mode the next queued run for `session` must carry. Both the
 * TypeScript enqueue path and the `reject_session_stage` RPC caller stamp their
 * run rows from this so the worker sees the same shape regardless of which
 * transition queued the work. The model lookup is the same one
 * pipeline/processor.ts performs at execution time; drift between the two
 * re-introduces the original placeholder-model bug.
 */
export async function resolveQueuedRunConfig(
  admin: AdminClient,
  session: Pick<SessionForEnqueue, "id" | "workspace_id">,
  runType?: WallieRunMode,
): Promise<QueuedRunConfig> {
  const [agentConfig, resolvedRunType] = await Promise.all([
    loadWorkspaceAgentConfig(admin, session.workspace_id),
    runType ?? inferSessionRunType(admin, session),
  ]);
  return {
    modelName: agentConfig.model,
    modelProvider: agentConfig.provider,
    runType: resolvedRunType,
  };
}

/**
 * Commit a new job and its run together, or adopt the session's active job.
 * Legacy producers may have inserted a job without an active run. A durable
 * accepted job is enough to acknowledge enqueue without waiting for a worker.
 */
export async function enqueueSessionJobWithRun(
  input: EnqueueSessionJobWithRunInput,
): Promise<EnqueueWallieRunResult> {
  const { admin, session } = input;
  const runConfig = await resolveQueuedRunConfig(admin, session, input.runType);
  const { data, error } = await admin.rpc("enqueue_session_job_with_run", {
    p_session_id: session.id,
    p_workspace_id: session.workspace_id,
    p_expected_stage_id: session.current_stage_id,
    p_requested_by_member_id: input.requestedByMemberId ?? undefined,
    p_trigger_type: input.triggerType,
    p_agent_model_provider: runConfig.modelProvider,
    p_agent_model_name: runConfig.modelName,
    p_run_type: runConfig.runType,
  });
  if (error) throw error;
  const queued = data?.[0];
  if (!queued) throw new Error("Wallie enqueue returned no job.");

  const run = queued.run_id ? await loadRunById(admin, queued.run_id) : null;
  return {
    created: queued.created,
    jobId: queued.job_id,
    run: run && isActiveAgentRunStatus(run.status) ? run : null,
  };
}

export async function retryWallieRun(input: {
  admin?: AdminClient;
  requestedByMemberId: string;
  runId: string;
  supabase: SupabaseServerClient;
  workspace: WorkspaceAccessWorkspace;
}) {
  const admin = input.admin ?? createSupabaseAdminClient();
  const existingRun = await loadRunById(admin, input.runId);

  if (!existingRun || existingRun.workspace_id !== input.workspace.id) {
    throw new WallieActionError({
      code: "run_not_found",
      message: "Wallie run not found.",
      statusCode: 404,
    });
  }

  if (!["success", "error", "canceled"].includes(existingRun.status)) {
    throw new WallieActionError({
      code: "run_not_retryable",
      message: "Only completed or failed Wallie runs can be retried.",
      statusCode: 409,
    });
  }

  const validated = await validateQueuedRunRequest({
    admin,
    sessionId: existingRun.session_id,
    requestedRunType: parseWallieRunMode(existingRun.run_type),
    supabase: input.supabase,
    workspace: input.workspace,
  });

  if (validated.activeRun) {
    return {
      created: false,
      jobId: validated.activeRun.agent_job_id,
      run: validated.activeRun,
    } satisfies EnqueueWallieRunResult;
  }

  return enqueueSessionJobWithRun({
    admin,
    requestedByMemberId: input.requestedByMemberId,
    runType: validated.runType,
    session: validated.session,
    triggerType: "manual_retry",
  });
}

export type CancelWallieRunResult = {
  canceled: boolean;
  run: AgentRunRow;
};

/**
 * Cancel a run and the rest of its session's in-flight work: flip the active
 * job + run to `canceled`, stop the sandbox, and park the session in
 * `rejected`. Idempotent — a run that is already terminal is returned as-is
 * with `canceled: false`. There is at most one active run/job per session, so
 * cancelling "the run" cancels the stage's current attempt.
 */
export async function cancelWallieRun(input: {
  admin?: AdminClient;
  requestedByMemberId: string;
  runId: string;
  workspace: WorkspaceAccessWorkspace;
}) {
  const admin = input.admin ?? createSupabaseAdminClient();
  const existingRun = await loadRunById(admin, input.runId);

  if (!existingRun || existingRun.workspace_id !== input.workspace.id) {
    throw new WallieActionError({
      code: "run_not_found",
      message: "Wallie run not found.",
      statusCode: 404,
    });
  }

  // A run that already reached a terminal state has nothing to cancel. Return
  // it unchanged so the caller can treat a double-click as a no-op.
  if (!isActiveAgentRunStatus(existingRun.status)) {
    return { canceled: false, run: existingRun } satisfies CancelWallieRunResult;
  }

  await cancelSessionWork(admin, {
    parkPhaseStatus: true,
    reason: "Run canceled by a workspace member.",
    sessionId: existingRun.session_id,
  });

  const updatedRun = (await loadRunById(admin, input.runId)) ?? existingRun;
  return { canceled: true, run: updatedRun } satisfies CancelWallieRunResult;
}
