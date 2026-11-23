import "server-only";
import type { WorkflowIntakeSelection } from "@/lib/factory-workflows/intake-selection";

import { wakeWorker } from "@/lib/worker/wake";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { PinnedGitInput } from "@/lib/pipeline/types";
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
  getWallieSessionRunBlock,
  inferWallieRunMode,
  isWallieRunTerminalStatus,
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
import { RECOMMENDED_AGENT_EFFORT } from "@/lib/agent-config/contracts";
import { resolveFactoryExecutionProfile } from "@/lib/factory-definitions/execution-profile";
import { checkFactoryProfileCredentialReadiness } from "@/lib/factory-definitions/execution-profile-readiness";
import type { RoutingOverride } from "@/lib/model-routing/operation-contracts";
import {
  loadRoutedFactoryExecution,
  resolveRoutedFactoryExecutionProfile,
  type RoutedFactoryExecution,
} from "@/lib/model-routing/execution";
import {
  loadPinnedFactoryExecution,
  loadPinnedFactoryRepositoryId,
  type PinnedFactoryExecution,
} from "@/lib/factory-definitions/runtime-definition";
import { resolveSandboxImplementation } from "@/lib/sandbox";
import {
  assertCurrentSandboxCapabilityCheck,
  SandboxCapabilityCheckStaleError,
} from "@/lib/sandbox-capabilities/readiness";
import { loadWorkspaceSandboxOverview, providerLabel } from "@/lib/sandbox-connections/server";
import type { SandboxProvider } from "@/lib/sandbox/types";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** Read the durable generation input before provisioning its initial or retry sandbox. */
export async function loadPinnedSessionJobGitInput(input: {
  admin: AdminClient;
  jobId: string;
  sessionId: string;
  workspaceId: string;
}): Promise<PinnedGitInput | null> {
  const { data, error } = await input.admin
    .from("session_job_git_inputs")
    .select("*")
    .eq("job_id", input.jobId)
    .eq("session_id", input.sessionId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Pin before executing any agent code. Empty receipts indicate lost ownership. */
export async function pinSessionJobGitInput(input: {
  admin: AdminClient;
  jobId: string;
  attemptCount: number;
  runId: string;
  repositoryId: string;
  baseBranch: string;
  observedSha: string;
  signal?: AbortSignal;
}): Promise<PinnedGitInput | null> {
  input.signal?.throwIfAborted();
  const request = input.admin.rpc("pin_session_job_git_input", {
    p_job_id: input.jobId,
    p_attempt_count: input.attemptCount,
    p_run_id: input.runId,
    p_repository_id: input.repositoryId,
    p_base_branch: input.baseBranch,
    p_observed_sha: input.observedSha,
  });
  const { data, error } = await (input.signal ? request.abortSignal(input.signal) : request);
  input.signal?.throwIfAborted();
  if (error) throw error;
  return data?.[0] ?? null;
}
type WorkspaceAccessWorkspace = Pick<Tables<"workspaces">, "id" | "name" | "slug">;
type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type SessionForRun = Pick<
  Tables<"sessions">,
  | "archived_at"
  | "created_at"
  | "creator_member_id"
  | "current_stage_id"
  | "execute_pinned_definition"
  | "factory_definition_revision_id"
  | "factory_id"
  | "github_repository_id"
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
  "id, workspace_id, number, title, prompt_md, current_stage_id, created_at, creator_member_id, archived_at, phase_status, execute_pinned_definition, factory_definition_revision_id, factory_id, github_repository_id";
const runSelect =
  "id, workspace_id, session_id, agent_job_id, attempt_count, branch_name, triggered_by_member_id, run_type, stage_id, stage_slug, stage_name, model_provider, model_name, status, started_at, finished_at, last_activity_at, input_tokens, output_tokens, total_cost_usd, token_provenance, cost_provenance, usage_finalized_at, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id, created_at, updated_at";
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
  /**
   * Mode stamped on the queued run. Defaults to the mode inferred from the
   * session's effective repository — the same resolution the processor
   * performs at run time.
   */
  runType?: WallieRunMode;
  session: SessionForEnqueue;
} & (
  | {
      requestedByMemberId: string | null;
      triggerType: Enums<"agent_trigger_type">;
      retryRunId?: never;
    }
  | { requestedByMemberId: string; triggerType: "manual_retry"; retryRunId: string }
);

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
  pinned?: PinnedFactoryExecution | null;
  workspaceId: string;
}): Promise<SessionFirstRunPrerequisites> {
  const admin = input.admin ?? createSupabaseAdminClient();
  const profile = input.pinned ? resolveFactoryExecutionProfile(input.pinned) : null;
  const [agentConfig, vercelSandboxConnection] = await Promise.all([
    input.pinned && profile
      ? {
          ...input.pinned.agent,
          provider: profile.provider,
          model: profile.model,
          effort: profile.effort ?? RECOMMENDED_AGENT_EFFORT,
        }
      : loadWorkspaceAgentConfig(admin, input.workspaceId),
    loadWallieVercelSandboxConnection(admin, input.workspaceId, profile?.sandboxProvider),
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

export async function assertSessionFactoryCredentialReady(input: {
  admin: AdminClient;
  creatorMemberId?: string | null;
  definition: PinnedFactoryExecution | null;
  factoryId: string;
  routing?: RoutedFactoryExecution | null;
  workspaceId: string;
}) {
  const { definition } = input;
  if (!definition) return null;

  const profile = resolveRoutedFactoryExecutionProfile(
    definition,
    input.routing,
    input.creatorMemberId,
  );
  if (profile.unavailableReason) {
    throw new WallieActionError({
      code: "factory_profile_unavailable",
      message: profile.unavailableReason,
      statusCode: 422,
    });
  }
  const readiness = await checkFactoryProfileCredentialReadiness({ ...input, profile });
  if (readiness.status === "unavailable") {
    throw new WallieActionError({
      code: "factory_credential_unavailable",
      message: readiness.reason,
      statusCode: 422,
    });
  }
  return profile;
}

export async function assertSessionSandboxCapabilityReady(input: {
  admin?: AdminClient;
  agentConfig: Pick<SessionFirstRunPrerequisites["agentConfig"], "model" | "provider">;
  definitionDigest?: string;
  qualificationId?: string;
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
      agent: { provider: input.agentConfig.provider, model: input.agentConfig.model },
      connection: { provider, revision },
      ...(input.definitionDigest === undefined ? {} : { definitionDigest: input.definitionDigest }),
      ...(input.qualificationId === undefined ? {} : { qualificationId: input.qualificationId }),
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
  commandFactoryId?: string | null;
  creationRequest?: { id: string; fingerprint: string };
  creatorMemberId: string;
  draftSpecification?: boolean;
  /** A null snapshot confirms that the default factory has no active revision. */
  factoryDefinitionDigest?: string | null;
  githubRepositoryId: string | null;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  modelName: string;
  modelProvider: string;
  pipelineId?: string | null;
  promptMd: string;
  restartOfSessionId?: string;
  routingOverride?: RoutingOverride;
  selectedStageIds?: string[];
  title: string;
  workflowSelection?: WorkflowIntakeSelection;
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
  if (input.restartOfSessionId && !input.creationRequest) {
    throw new Error("A creation request id is required to restart a session.");
  }
  if (input.draftSpecification && input.commandFactoryId === undefined) {
    throw new Error("A confirmed session command is required to draft a specification.");
  }
  if (input.commandFactoryId !== undefined && input.factoryDefinitionDigest === undefined) {
    throw new Error("A confirmed factory definition is required for a session command.");
  }
  if (input.factoryDefinitionDigest !== undefined && !input.creationRequest) {
    throw new Error("A creation request id is required to confirm a factory definition.");
  }
  const requestArgs = input.creationRequest
    ? {
        ...args,
        target_request_id: input.creationRequest.id,
        target_request_hash: input.creationRequest.fingerprint,
      }
    : null;
  const confirmationArgs =
    requestArgs && input.factoryDefinitionDigest !== undefined
      ? {
          ...requestArgs,
          expected_factory_definition_digest: input.factoryDefinitionDigest ?? "",
          source_session_id: input.restartOfSessionId,
        }
      : null;
  const commandArgs =
    confirmationArgs && input.commandFactoryId !== undefined
      ? {
          ...confirmationArgs,
          target_factory_id: input.commandFactoryId ?? undefined,
          draft_specification: input.draftSpecification || undefined,
        }
      : null;
  if (
    input.workflowSelection &&
    (!commandArgs ||
      !input.factoryDefinitionDigest ||
      input.routingOverride ||
      input.draftSpecification ||
      input.restartOfSessionId)
  ) {
    throw new Error("A confirmed new factory session is required to select a published workflow.");
  }
  if (
    input.routingOverride &&
    (!commandArgs ||
      !input.factoryDefinitionDigest ||
      input.restartOfSessionId ||
      input.draftSpecification)
  ) {
    throw new Error("A confirmed new pipeline session is required for a routing override.");
  }
  const query = commandArgs
    ? input.routingOverride
      ? admin.rpc("create_session_command_with_routing_override", {
          ...commandArgs,
          p_routing_override: input.routingOverride,
        })
      : admin.rpc("create_session_command_once", {
          ...commandArgs,
          ...(input.workflowSelection ? { p_workflow_selection: input.workflowSelection } : {}),
        })
    : confirmationArgs
      ? admin.rpc("create_confirmed_factory_session_once_with_first_job", confirmationArgs)
      : requestArgs
        ? input.restartOfSessionId
          ? admin.rpc("restart_session_once_with_first_job", {
              ...requestArgs,
              source_session_id: input.restartOfSessionId,
            })
          : admin.rpc("create_session_once_with_first_job", requestArgs)
        : admin.rpc("create_session_with_first_job_and_attachments", args);
  const { data, error } = await query.single();

  if (error || !data) {
    throw error ?? new Error("Wallie could not create that session.");
  }

  await wakeWorker();

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
  commandFactoryId?: string | null;
  creationRequest: { id: string; fingerprint: string };
  creatorMemberId: string;
  draftSpecification?: boolean;
  restartOfSessionId?: string;
  workflowSelection?: WorkflowIntakeSelection;
  workspaceId: string;
}): Promise<CreateSessionWithFirstJobResult | null> {
  const args = {
    target_workspace_id: input.workspaceId,
    creator_member_id: input.creatorMemberId,
    target_request_id: input.creationRequest.id,
    target_request_hash: input.creationRequest.fingerprint,
  };
  const query =
    input.commandFactoryId === undefined
      ? input.admin.rpc("find_session_creation_request", args)
      : input.admin.rpc("find_session_creation_command", {
          ...args,
          draft_specification: input.draftSpecification || undefined,
          ...(input.workflowSelection ? { p_workflow_selection: input.workflowSelection } : {}),
          source_session_id: input.restartOfSessionId,
          target_factory_id: input.commandFactoryId ?? undefined,
        });
  const { data, error } = await query.maybeSingle();
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
  requestedProvider?: SandboxProvider,
): Promise<WallieVercelSandboxConnectionStatus> {
  const overview = await loadWorkspaceSandboxOverview(admin, workspaceId);
  const provider = requestedProvider ?? overview.activeProvider;
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

async function loadRunById(supabase: AdminClient, runId: string) {
  const { data, error } = await supabase
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

  const sessionBlock = getWallieSessionRunBlock({
    archivedAt: session.archived_at,
    phaseStatus: session.phase_status,
  });
  if (sessionBlock) {
    throw new WallieActionError({
      ...sessionBlock,
      statusCode: 409,
    });
  }

  const workspace = input.workspace;
  const activeRun = await loadActiveRunForSession(input.admin, session.id);
  if (activeRun) return { activeRun, session, runType: input.requestedRunType };

  const definition = await loadPinnedFactoryExecution(input.admin, session);
  const routing = definition?.modelRouting
    ? await loadRoutedFactoryExecution(input.admin, session)
    : null;
  const profile = await assertSessionFactoryCredentialReady({
    admin: input.admin,
    creatorMemberId: session.creator_member_id,
    definition,
    factoryId: session.factory_id,
    routing,
    workspaceId: workspace.id,
  });
  const pinnedRepositoryId = definition
    ? await loadPinnedFactoryRepositoryId(input.admin, session, definition)
    : undefined;
  const runType = definition ? inferWallieRunMode(pinnedRepositoryId) : input.requestedRunType;
  const [repositoryResolution, vercelSandboxConnection] = await Promise.all([
    resolveEffectiveSessionRepository({
      factoryId: session.factory_id,
      pinnedRepositoryId,
      sessionId: session.id,
      supabase: input.admin,
      workspaceId: workspace.id,
    }),
    loadWallieVercelSandboxConnection(input.admin, workspace.id, profile?.sandboxProvider),
  ]);
  if (routing && vercelSandboxConnection.connectionRevision !== routing.sandboxConnectionRevision) {
    throw new WallieActionError({
      code: "sandbox_capability_check_stale",
      message: "The sandbox connection pinned by routing is unavailable.",
      provider: routing.sandboxProvider,
      statusCode: 422,
    });
  }
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

  const agentConfig = profile ?? (await loadWorkspaceAgentConfig(input.admin, workspace.id));
  await assertSessionSandboxCapabilityReady({
    admin: input.admin,
    agentConfig,
    definitionDigest: routing?.definitionDigest ?? definition?.canonicalDigest,
    qualificationId: routing?.configuration.qualificationId,
    repository,
    sandboxConnection: vercelSandboxConnection,
    workspaceId: workspace.id,
  });

  return { activeRun, session, runType };
}

async function inferSessionRunType(
  admin: AdminClient,
  session: Pick<SessionForEnqueue, "id" | "workspace_id">,
  factoryId: string | undefined,
): Promise<WallieRunMode> {
  if (!factoryId) return inferWallieRunMode(null);
  const resolution = await resolveEffectiveSessionRepository({
    factoryId,
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
  usesPinnedDefinition: boolean;
};

/**
 * Model and run mode the next queued run for `session` must carry. Both the
 * TypeScript enqueue path and the `reject_session_stage` RPC caller stamp their
 * run rows from the same definition the worker uses. Compatibility sessions
 * continue to read the workspace configuration and effective repository.
 */
export async function resolveQueuedRunConfig(
  admin: AdminClient,
  session: Pick<SessionForEnqueue, "id" | "workspace_id">,
  runType?: WallieRunMode,
): Promise<QueuedRunConfig> {
  const { data, error } = await admin
    .from("sessions")
    .select("execute_pinned_definition, factory_definition_revision_id, factory_id, workspace_id")
    .eq("id", session.id)
    .eq("workspace_id", session.workspace_id)
    .maybeSingle();
  if (error) throw error;
  const definition = data ? await loadPinnedFactoryExecution(admin, data) : null;
  if (data && definition) {
    const routing = definition.modelRouting
      ? await loadRoutedFactoryExecution(admin, { ...data, id: session.id })
      : null;
    const profile = resolveRoutedFactoryExecutionProfile(definition, routing);
    return {
      modelName: profile.model,
      modelProvider: profile.provider,
      runType: "code",
      usesPinnedDefinition: true,
    };
  }
  const [agentConfig, resolvedRunType] = await Promise.all([
    loadWorkspaceAgentConfig(admin, session.workspace_id),
    runType ?? inferSessionRunType(admin, session, data?.factory_id),
  ]);
  return {
    modelName: agentConfig.model,
    modelProvider: agentConfig.provider,
    runType: resolvedRunType,
    usesPinnedDefinition: false,
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
  const args = {
    p_session_id: session.id,
    p_workspace_id: session.workspace_id,
    p_expected_stage_id: session.current_stage_id,
    p_agent_model_provider: runConfig.modelProvider,
    p_agent_model_name: runConfig.modelName,
    p_run_type: runConfig.runType,
  };
  const retryEnqueue =
    input.retryRunId === undefined
      ? null
      : await admin.rpc("enqueue_session_retry_with_checkpoint", {
          ...args,
          p_requested_by_member_id: input.requestedByMemberId,
          p_retry_run_id: input.retryRunId,
        });
  // Compatibility sessions keep the original fallback during schema rollover.
  // Pinned Retry always uses the exact checkpoint-aware path.
  const { data, error } =
    retryEnqueue && (runConfig.usesPinnedDefinition || retryEnqueue.error?.code !== "PGRST202")
      ? retryEnqueue
      : await admin.rpc("enqueue_session_job_with_run", {
          ...args,
          p_requested_by_member_id: input.requestedByMemberId ?? undefined,
          p_trigger_type: input.triggerType,
        });
  if (error) throw error;
  const queued = data?.[0];
  if (!queued) throw new Error("Wallie enqueue returned no job.");
  if (!queued.job_id) {
    throw new WallieActionError({
      code: "execution_budget_exhausted",
      message: "Session execution budget is exhausted; no new execution was queued.",
      statusCode: 409,
    });
  }

  await wakeWorker();

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
  const existingRun = await loadRunById(input.supabase, input.runId);

  if (!existingRun || existingRun.workspace_id !== input.workspace.id) {
    throw new WallieActionError({
      code: "run_not_found",
      message: "Wallie run not found.",
      statusCode: 404,
    });
  }

  if (!isWallieRunTerminalStatus(existingRun.status)) {
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
    retryRunId: existingRun.id,
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
  supabase?: SupabaseServerClient;
  workspace: WorkspaceAccessWorkspace;
}) {
  const admin = input.admin ?? createSupabaseAdminClient();
  const existingRun = await loadRunById(input.supabase ?? admin, input.runId);

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

  const receipt = await cancelSessionWork(admin, {
    expectedRunId: existingRun.id,
    parkPhaseStatus: true,
    reason: "Run canceled by a workspace member.",
    sessionId: existingRun.session_id,
    workspaceId: input.workspace.id,
  });

  const updatedRun = (await loadRunById(admin, input.runId)) ?? existingRun;
  return {
    canceled: receipt.canceledRunIds.includes(existingRun.id),
    run: updatedRun,
  } satisfies CancelWallieRunResult;
}
