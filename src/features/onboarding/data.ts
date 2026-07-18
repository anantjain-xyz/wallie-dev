import "server-only";

import { loadWorkspaceGitHubData, type WorkspaceGitHubData } from "@/features/github/data";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import {
  agentConfigEntriesToMap,
  buildVerifyChecklist,
  configuredAgentConfigKeys,
  verifyBlockersFromChecklist,
  type AgentConfigMap,
  type VerifyBlocker,
} from "@/features/onboarding/runtime-readiness";
import type { WorkspaceMemberSummary } from "@/features/pipeline/editor-primitives";
import type { PipelineStage, SessionPipeline } from "@/features/sessions/types";
import type { LinearRoutingConfig } from "@/lib/linear-routing/contracts";
import { loadLinearRoutingConfig } from "@/lib/linear-routing/server";
import { credentialExpired, isCodexCredentialType } from "@/lib/codex/contracts";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables, TablesUpdate } from "@/lib/supabase/database.types";
import {
  type OnboardingSetupHealth,
  WORKSPACE_ONBOARDING_STEPS,
  type WorkspaceOnboardingState,
  type WorkspaceOnboardingStep,
  type WorkspaceOnboardingUpdatePayload,
  workspaceOnboardingStatusSchema,
  workspaceOnboardingStepSchema,
} from "@/lib/onboarding/contracts";
import { type WorkspaceAccessContext, requireWorkspaceAccessById } from "@/lib/workspaces/access";
import { loadVercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/server";
import type { VercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/contracts";

const onboardingSelect =
  "id, workspace_id, status, current_step, selected_github_repository_id, completed_steps, skipped_steps, dismissed_at, completed_at, created_at, updated_at";

type OnboardingAccessFailure = {
  error: string;
  ok: false;
  status: 400 | 401 | 403 | 404;
};

export type WorkspaceOnboardingData = {
  agentConfig: AgentConfigMap;
  canManage: boolean;
  currentMember: {
    id: string;
    role: "admin" | "agent" | "member" | "owner";
  };
  github: WorkspaceGitHubData;
  linearRouting: LinearRoutingConfig;
  linearSecret: WorkspaceSecretPreview | null;
  onboarding: WorkspaceOnboardingState;
  pipeline: SessionPipeline | null;
  setupHealth: OnboardingSetupHealth;
  vercelSandboxConnection: VercelSandboxConnectionPreview | null;
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
  workspaceMembers: WorkspaceMemberSummary[];
  workspaceSecrets: WorkspaceSecretPreview[];
};

export type WorkspaceOnboardingSnapshot = {
  data: Promise<WorkspaceOnboardingData>;
  github: Promise<WorkspaceGitHubData>;
};

type OnboardingDataResult =
  | {
      data: WorkspaceOnboardingData;
      ok: true;
    }
  | OnboardingAccessFailure;

type SandboxCapabilityCheckRow = Pick<
  Tables<"sandbox_capability_checks">,
  | "capabilities"
  | "checked_at"
  | "error_text"
  | "github_repository_id"
  | "id"
  | "sandbox_provider"
  | "sandbox_vercel_project_id"
  | "sandbox_vercel_team_id"
  | "status"
>;

type AgentConfigRow = Pick<Tables<"workspace_agent_config">, "key" | "value_json">;

type SecretPreviewRow = Pick<
  Tables<"workspace_secrets">,
  | "created_at"
  | "created_by_member_id"
  | "id"
  | "key"
  | "updated_at"
  | "value_preview"
  | "workspace_id"
>;

function mapOnboardingRow(row: Tables<"workspace_onboarding">): WorkspaceOnboardingState {
  return {
    completedAt: row.completed_at,
    completedSteps: row.completed_steps.map((step) => workspaceOnboardingStepSchema.parse(step)),
    createdAt: row.created_at,
    currentStep: workspaceOnboardingStepSchema.parse(row.current_step),
    dismissedAt: row.dismissed_at,
    id: row.id,
    selectedGithubRepositoryId:
      typeof row.selected_github_repository_id === "string"
        ? row.selected_github_repository_id
        : null,
    skippedSteps: row.skipped_steps.map((step) => workspaceOnboardingStepSchema.parse(step)),
    status: workspaceOnboardingStatusSchema.parse(row.status),
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

async function loadOrCreateOnboardingRow(
  context: WorkspaceAccessContext,
  admin = createSupabaseAdminClient(),
): Promise<Tables<"workspace_onboarding">> {
  const { data: existingRow, error: existingError } = await context.supabase
    .from("workspace_onboarding")
    .select(onboardingSelect)
    .eq("workspace_id", context.workspace.id)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existingRow) return existingRow;

  const { data: repairedRow, error: repairError } = await admin
    .from("workspace_onboarding")
    .upsert({ workspace_id: context.workspace.id }, { onConflict: "workspace_id" })
    .select(onboardingSelect)
    .single();

  if (repairError) throw repairError;
  return repairedRow;
}

function mapSandboxCapabilityCheck(
  row: SandboxCapabilityCheckRow | null | undefined,
): SandboxCapabilityCheckState | null {
  if (!row) return null;
  return {
    capabilities:
      typeof row.capabilities === "object" && row.capabilities !== null
        ? (row.capabilities as SandboxCapabilityCheckState["capabilities"])
        : {},
    checkedAt: typeof row.checked_at === "string" ? row.checked_at : new Date().toISOString(),
    errorText: typeof row.error_text === "string" ? row.error_text : null,
    githubRepositoryId:
      typeof row.github_repository_id === "string" ? row.github_repository_id : null,
    id: typeof row.id === "string" ? row.id : null,
    sandboxProvider:
      row.sandbox_provider === "vercel" || row.sandbox_provider === "fake"
        ? row.sandbox_provider
        : null,
    sandboxVercelProjectId: row.sandbox_vercel_project_id,
    sandboxVercelTeamId: row.sandbox_vercel_team_id,
    status:
      row.status === "success" || row.status === "error" || row.status === "running"
        ? row.status
        : "error",
  };
}

function mapSecretPreview(row: SecretPreviewRow): WorkspaceSecretPreview {
  return {
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
    id: row.id,
    key: row.key,
    updatedAt: row.updated_at,
    valuePreview: row.value_preview,
    workspaceId: row.workspace_id,
  };
}

function codexConnectionStatus(
  row: {
    access_token_expires_at: string | null;
    auth_reconnect_required: boolean;
    credential_type: string;
    updated_at: string;
  } | null,
) {
  if (!row || !isCodexCredentialType(row.credential_type)) {
    return {
      connected: false,
      credentialType: null,
      expiresAt: null,
      status: "missing" as const,
      updatedAt: null,
    };
  }

  const isExpired = credentialExpired(row.access_token_expires_at);
  const reconnectRequired =
    row.credential_type === "chatgpt_auth_json" && row.auth_reconnect_required;

  return {
    connected: !isExpired && !reconnectRequired,
    credentialType: row.credential_type,
    expiresAt: row.access_token_expires_at,
    status: isExpired || reconnectRequired ? ("expired" as const) : ("connected" as const),
    updatedAt: row.updated_at,
  };
}

function claudeCodeConnectionStatus(row: { updated_at: string } | null) {
  if (!row) {
    return {
      connected: false,
      status: "missing" as const,
      updatedAt: null,
    };
  }

  return {
    connected: true,
    status: "connected" as const,
    updatedAt: row.updated_at,
  };
}

async function loadSetupHealth(
  context: WorkspaceAccessContext,
  github: WorkspaceGitHubData,
  selectedGithubRepositoryId: string | null,
  admin = createSupabaseAdminClient(),
  options: { includeSecretKeyInventory?: boolean } = {},
): Promise<OnboardingSetupHealth> {
  const workspaceId = context.workspace.id;
  const repositoryHealth = buildRepositorySetupHealth(github, selectedGithubRepositoryId);
  const primaryRepositoryId = repositoryHealth.primaryRepositoryProfile.repositoryId;
  let sandboxQuery = admin
    .from("sandbox_capability_checks")
    .select(
      "id, github_repository_id, status, capabilities, error_text, checked_at, sandbox_provider, sandbox_vercel_team_id, sandbox_vercel_project_id",
    )
    .eq("workspace_id", workspaceId);

  if (primaryRepositoryId) {
    sandboxQuery = sandboxQuery.eq("github_repository_id", primaryRepositoryId);
  }

  const latestSandboxQuery = sandboxQuery.order("checked_at", { ascending: false }).limit(1);

  const [
    { data: pipelineRow, error: pipelineError },
    { data: stageRows, error: stageError },
    { data: secretRows, error: secretsError },
    { data: linearRouting, error: linearRoutingError },
    { data: agentConfigRows, error: agentConfigError },
    { data: codexCredentials, error: codexError },
    { data: claudeCodeCredentials, error: claudeCodeError },
    { data: sandboxRows, error: sandboxError },
    vercelSandboxConnection,
  ] = await Promise.all([
    admin
      .from("pipelines")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("is_default", true)
      .maybeSingle(),
    admin.from("pipeline_stages").select("id, pipeline_id").eq("workspace_id", workspaceId),
    options.includeSecretKeyInventory
      ? admin.from("workspace_secrets").select("key, updated_at").eq("workspace_id", workspaceId)
      : admin
          .from("workspace_secrets")
          .select("key, updated_at")
          .eq("workspace_id", workspaceId)
          .in("key", ["LINEAR_API_KEY"]),
    admin
      .from("workspace_linear_routing")
      .select("id, updated_at")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    admin.from("workspace_agent_config").select("key, value_json").eq("workspace_id", workspaceId),
    admin
      .from("user_codex_credentials")
      .select("access_token_expires_at, auth_reconnect_required, credential_type, updated_at")
      .eq("user_id", context.user.id)
      .maybeSingle(),
    admin
      .from("user_claude_code_credentials")
      .select("updated_at")
      .eq("user_id", context.user.id)
      .maybeSingle(),
    latestSandboxQuery,
    loadVercelSandboxConnectionPreview(admin, workspaceId),
  ]);

  const firstError =
    pipelineError ??
    stageError ??
    secretsError ??
    linearRoutingError ??
    agentConfigError ??
    codexError ??
    claudeCodeError ??
    sandboxError;
  if (firstError) throw firstError;

  const stageCount = pipelineRow
    ? (stageRows ?? []).filter((stage) => stage.pipeline_id === pipelineRow.id).length
    : 0;
  const agentConfig = agentConfigEntriesToMap(
    ((agentConfigRows ?? []) as AgentConfigRow[]).map((row) => ({
      key: row.key,
      value: row.value_json,
    })),
  );
  const configuredKeys = configuredAgentConfigKeys(agentConfig);
  const secretKeys = [...new Set((secretRows ?? []).map((row) => row.key))].sort();
  const linearSecret = (secretRows ?? []).find((row) => row.key === "LINEAR_API_KEY") ?? null;
  const linearRoutingUpdatedAt =
    typeof linearRouting?.updated_at === "string" ? linearRouting.updated_at : null;

  return {
    agentConfig: {
      configured: configuredKeys.length > 0,
      configuredKeys,
      status: configuredKeys.length > 0 ? "present" : "missing",
      values: agentConfig,
    },
    claudeCodeConnection: claudeCodeConnectionStatus(claudeCodeCredentials),
    codexConnection: codexConnectionStatus(codexCredentials),
    defaultPipeline: {
      configured: Boolean(pipelineRow && stageCount > 0),
      pipelineId: pipelineRow?.id ?? null,
      stageCount,
      status: pipelineRow && stageCount > 0 ? "ready" : "missing",
    },
    githubInstallation: {
      connected: Boolean(github.installation && !github.installation.suspended),
      installationId: github.installation?.installationId ?? null,
      status: github.installation ? "present" : "missing",
      suspended: github.installation?.suspended ?? null,
      targetName: github.installation?.targetName ?? null,
      updatedAt: github.installation?.updatedAt ?? null,
    },
    latestSandboxCapabilityCheck: mapSandboxCapabilityCheck(sandboxRows?.[0]),
    vercelSandboxConnection: vercelSandboxConnection
      ? {
          connected: vercelSandboxConnection.status === "connected",
          lastValidationError: vercelSandboxConnection.lastValidationError,
          projectId: vercelSandboxConnection.projectId,
          projectName: vercelSandboxConnection.projectName,
          status: vercelSandboxConnection.status,
          teamId: vercelSandboxConnection.teamId,
          updatedAt: vercelSandboxConnection.updatedAt,
        }
      : {
          connected: false,
          lastValidationError: null,
          projectId: null,
          projectName: null,
          status: "missing",
          teamId: null,
          updatedAt: null,
        },
    linearKey: {
      configured: Boolean(linearSecret),
      status: linearSecret ? "present" : "missing",
      updatedAt: linearSecret?.updated_at ?? null,
    },
    linearRouting: {
      configured: Boolean(linearRouting),
      status: linearRouting ? "present" : "missing",
      updatedAt: linearRoutingUpdatedAt,
    },
    workspaceSecrets: {
      configuredKeys: options.includeSecretKeyInventory ? secretKeys : [],
    },
    ...repositoryHealth,
  };
}

async function loadDefaultPipeline(
  context: WorkspaceAccessContext,
): Promise<SessionPipeline | null> {
  const { data: pipelineRow, error: pipelineError } = await context.supabase
    .from("pipelines")
    .select("id, name, is_default, operating_rules_md")
    .eq("workspace_id", context.workspace.id)
    .eq("is_default", true)
    .maybeSingle();

  if (pipelineError) throw pipelineError;
  if (!pipelineRow) return null;

  const { data: stageRows, error: stageError } = await context.supabase
    .from("pipeline_stages")
    .select(
      "id, pipeline_id, position, slug, name, description, prompt_template_md, approver_member_ids",
    )
    .eq("pipeline_id", pipelineRow.id)
    .order("position", { ascending: true });

  if (stageError) throw stageError;

  const stages: PipelineStage[] = (stageRows ?? []).map((stage) => ({
    approverMemberIds: stage.approver_member_ids ?? [],
    description: stage.description,
    id: stage.id,
    name: stage.name,
    pipelineId: stage.pipeline_id,
    position: stage.position,
    promptTemplateMd: stage.prompt_template_md,
    slug: stage.slug,
  }));

  return {
    id: pipelineRow.id,
    isDefault: pipelineRow.is_default,
    name: pipelineRow.name,
    operatingRulesMd: pipelineRow.operating_rules_md ?? "",
    stages,
  };
}

async function loadWorkspaceMembers(
  context: WorkspaceAccessContext,
): Promise<WorkspaceMemberSummary[]> {
  const { data, error } = await context.supabase
    .from("workspace_members")
    .select("id, full_name, email, role, kind, is_active")
    .eq("workspace_id", context.workspace.id)
    .eq("kind", "human")
    .eq("is_active", true)
    .order("full_name", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((member) => ({
    email: member.email,
    fullName: member.full_name,
    id: member.id,
    role: member.role as WorkspaceMemberSummary["role"],
  }));
}

async function loadLinearSecretPreview(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
): Promise<WorkspaceSecretPreview | null> {
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("id, key, workspace_id, value_preview, created_by_member_id, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .eq("key", "LINEAR_API_KEY")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return mapSecretPreview(data);
}

async function loadWorkspaceSecretPreviews(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
): Promise<WorkspaceSecretPreview[]> {
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("id, key, workspace_id, value_preview, created_by_member_id, created_at, updated_at")
    .eq("workspace_id", workspaceId)
    .order("key", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as SecretPreviewRow[]).map(mapSecretPreview);
}

async function loadAgentConfig(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
): Promise<AgentConfigMap> {
  const { data, error } = await admin
    .from("workspace_agent_config")
    .select("key, value_json")
    .eq("workspace_id", workspaceId);

  if (error) throw error;
  return agentConfigEntriesToMap(
    ((data ?? []) as AgentConfigRow[]).map((row) => ({ key: row.key, value: row.value_json })),
  );
}

export function createWorkspaceOnboardingSnapshot(
  context: WorkspaceAccessContext,
  options?: {
    onboardingRow?: Tables<"workspace_onboarding">;
  },
): WorkspaceOnboardingSnapshot {
  const admin = createSupabaseAdminClient();
  const canManage =
    context.currentMember.role === "owner" || context.currentMember.role === "admin";
  const workspaceId = context.workspace.id;
  const onboardingRowPromise = options?.onboardingRow
    ? Promise.resolve(options.onboardingRow)
    : loadOrCreateOnboardingRow(context, admin);
  const githubPromise = loadWorkspaceGitHubData(admin, workspaceId);

  // Start every independent summary as soon as permission is known. The setup
  // health promise alone waits for the onboarding row and GitHub summary that
  // determine repository-specific health.
  const pipelinePromise = loadDefaultPipeline(context);
  const workspaceMembersPromise = loadWorkspaceMembers(context);
  const linearRoutingPromise = loadLinearRoutingConfig(admin, workspaceId);
  const linearSecretPromise = canManage
    ? loadLinearSecretPreview(admin, workspaceId)
    : Promise.resolve(null);
  const workspaceSecretsPromise = canManage
    ? loadWorkspaceSecretPreviews(admin, workspaceId)
    : Promise.resolve([]);
  const agentConfigPromise = loadAgentConfig(admin, workspaceId);
  const vercelSandboxConnectionPromise = loadVercelSandboxConnectionPreview(admin, workspaceId);
  const setupHealthPromise = Promise.all([onboardingRowPromise, githubPromise]).then(
    ([onboardingRow, github]) =>
      loadSetupHealth(
        context,
        github,
        mapOnboardingRow(onboardingRow).selectedGithubRepositoryId,
        admin,
        { includeSecretKeyInventory: canManage },
      ),
  );

  const data = Promise.all([
    onboardingRowPromise,
    githubPromise,
    setupHealthPromise,
    pipelinePromise,
    workspaceMembersPromise,
    linearRoutingPromise,
    linearSecretPromise,
    workspaceSecretsPromise,
    agentConfigPromise,
    vercelSandboxConnectionPromise,
  ]).then(
    ([
      onboardingRow,
      github,
      setupHealth,
      pipeline,
      workspaceMembers,
      linearRouting,
      linearSecret,
      workspaceSecrets,
      agentConfig,
      vercelSandboxConnection,
    ]) => ({
      agentConfig,
      canManage,
      currentMember: {
        id: context.currentMember.id,
        role: context.currentMember.role,
      },
      github,
      linearRouting,
      linearSecret,
      onboarding: mapOnboardingRow(onboardingRow),
      pipeline,
      setupHealth,
      vercelSandboxConnection,
      workspace: {
        id: context.workspace.id,
        name: context.workspace.name,
        slug: context.workspace.slug,
      },
      workspaceMembers,
      workspaceSecrets,
    }),
  );

  return { data, github: githubPromise };
}

export function loadWorkspaceOnboardingDataForContext(
  context: WorkspaceAccessContext,
  options?: {
    onboardingRow?: Tables<"workspace_onboarding">;
  },
): Promise<WorkspaceOnboardingData> {
  return createWorkspaceOnboardingSnapshot(context, options).data;
}

export async function loadWorkspaceOnboardingData(
  workspaceId: string,
): Promise<OnboardingDataResult> {
  const access = await requireWorkspaceAccessById(workspaceId);

  if (!access.ok) {
    return {
      error: access.error,
      ok: false,
      status: access.status,
    };
  }

  return {
    data: await loadWorkspaceOnboardingDataForContext(access.context),
    ok: true,
  };
}

export async function updateWorkspaceOnboardingData(
  workspaceId: string,
  payload: WorkspaceOnboardingUpdatePayload,
): Promise<OnboardingDataResult> {
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });

  if (!access.ok) {
    return {
      error: access.error,
      ok: false,
      status: access.status,
    };
  }

  const admin = createSupabaseAdminClient();
  const { data: currentRow, error: currentError } = await access.context.supabase
    .from("workspace_onboarding")
    .select(onboardingSelect)
    .eq("workspace_id", access.context.workspace.id)
    .single();

  if (currentError) throw currentError;

  const normalizedPayload = await normalizeWorkspaceOnboardingUpdatePayload({
    admin,
    currentRow,
    payload,
    workspaceId: access.context.workspace.id,
  });

  if (!normalizedPayload.ok) {
    return normalizedPayload;
  }

  const updatePayload = buildWorkspaceOnboardingUpdatePayload(normalizedPayload.payload);

  const { data, error } = await access.context.supabase
    .from("workspace_onboarding")
    .update(updatePayload)
    .eq("workspace_id", access.context.workspace.id)
    .select(onboardingSelect)
    .single();

  if (error) throw error;

  return {
    data: await loadWorkspaceOnboardingDataForContext(access.context, { onboardingRow: data }),
    ok: true,
  };
}

const REPOSITORY_SELECTION_DEPENDENT_STEPS = new Set<WorkspaceOnboardingStep>([
  "repository",
  "runtime",
  "verify",
]);

async function loadPrimaryRepositoryProfileRepositoryId(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
) {
  const { data, error } = await admin
    .from("workspace_repository_profiles")
    .select("github_repository_id")
    .eq("workspace_id", workspaceId)
    .eq("is_primary", true)
    .maybeSingle();

  if (error) throw error;
  return typeof data?.github_repository_id === "string" ? data.github_repository_id : null;
}

export async function normalizeWorkspaceOnboardingUpdatePayload(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  currentRow: Tables<"workspace_onboarding">;
  payload: WorkspaceOnboardingUpdatePayload;
  workspaceId: string;
}): Promise<
  | { ok: true; payload: WorkspaceOnboardingUpdatePayload }
  | {
      error: string;
      ok: false;
      status: 400 | 404;
    }
> {
  const selectedRepositoryId = input.payload.selectedGithubRepositoryId;
  if (selectedRepositoryId === undefined) {
    return { ok: true, payload: input.payload };
  }

  if (selectedRepositoryId !== null) {
    const { data: repository, error } = await input.admin
      .from("github_repositories")
      .select("id, is_archived")
      .eq("id", selectedRepositoryId)
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();

    if (error) throw error;
    if (!repository) {
      return {
        error: "Repository not found.",
        ok: false,
        status: 404,
      };
    }
    if (repository.is_archived) {
      return {
        error: "Archived repositories cannot be selected.",
        ok: false,
        status: 400,
      };
    }
  }

  const currentSelectedRepositoryId =
    input.currentRow.selected_github_repository_id ??
    (await loadPrimaryRepositoryProfileRepositoryId(input.admin, input.workspaceId));

  if (selectedRepositoryId === currentSelectedRepositoryId) {
    if (selectedRepositoryId === input.currentRow.selected_github_repository_id) {
      return { ok: true, payload: input.payload };
    }

    return {
      ok: true,
      payload: {
        ...input.payload,
        completedSteps: input.currentRow.completed_steps.map((step) =>
          workspaceOnboardingStepSchema.parse(step),
        ),
        skippedSteps: input.currentRow.skipped_steps.map((step) =>
          workspaceOnboardingStepSchema.parse(step),
        ),
        status: workspaceOnboardingStatusSchema.parse(input.currentRow.status),
      },
    };
  }

  return {
    ok: true,
    payload: {
      ...input.payload,
      completedSteps: (input.payload.completedSteps ?? input.currentRow.completed_steps)
        .map((step) => workspaceOnboardingStepSchema.parse(step))
        .filter((step) => !REPOSITORY_SELECTION_DEPENDENT_STEPS.has(step)),
      status: input.payload.status ?? "in_progress",
      skippedSteps: (input.payload.skippedSteps ?? input.currentRow.skipped_steps)
        .map((step) => workspaceOnboardingStepSchema.parse(step))
        .filter((step) => !REPOSITORY_SELECTION_DEPENDENT_STEPS.has(step)),
    },
  };
}

type CompleteOnboardingResult =
  | {
      data: WorkspaceOnboardingData;
      ok: true;
    }
  | {
      blockers?: VerifyBlocker[];
      error: string;
      ok: false;
      status: 400 | 401 | 403 | 404 | 409;
    };

export async function completeWorkspaceOnboarding(
  workspaceId: string,
): Promise<CompleteOnboardingResult> {
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });

  if (!access.ok) {
    return {
      error: access.error,
      ok: false,
      status: access.status,
    };
  }

  const { data: onboardingRow, error: onboardingError } = await access.context.supabase
    .from("workspace_onboarding")
    .select(onboardingSelect)
    .eq("workspace_id", access.context.workspace.id)
    .single();

  if (onboardingError) throw onboardingError;

  const currentData = await loadWorkspaceOnboardingDataForContext(access.context, {
    onboardingRow,
  });
  const blockers = verifyBlockersFromChecklist(
    buildVerifyChecklist({
      agentConfig: currentData.agentConfig,
      health: currentData.setupHealth,
      onboarding: currentData.onboarding,
    }),
  );

  if (blockers.length > 0) {
    return {
      blockers,
      error: "Onboarding verification is blocked.",
      ok: false,
      status: 409,
    };
  }

  const updatePayload = buildWorkspaceOnboardingUpdatePayload({
    completedSteps: [...WORKSPACE_ONBOARDING_STEPS],
    currentStep: "verify",
    skippedSteps: [],
    status: "completed",
  });

  const { data, error } = await access.context.supabase
    .from("workspace_onboarding")
    .update(updatePayload)
    .eq("workspace_id", access.context.workspace.id)
    .select(onboardingSelect)
    .single();

  if (error) throw error;

  return {
    data: await loadWorkspaceOnboardingDataForContext(access.context, { onboardingRow: data }),
    ok: true,
  };
}

export function buildWorkspaceOnboardingUpdatePayload(
  payload: WorkspaceOnboardingUpdatePayload,
  now = new Date(),
): TablesUpdate<"workspace_onboarding"> {
  const updatePayload: TablesUpdate<"workspace_onboarding"> = {};

  if (payload.status !== undefined) {
    updatePayload.status = payload.status;
    if (payload.status === "dismissed") {
      updatePayload.dismissed_at = now.toISOString();
    } else if (payload.status === "completed") {
      updatePayload.completed_at = now.toISOString();
      updatePayload.dismissed_at = null;
    } else if (payload.status === "in_progress") {
      updatePayload.dismissed_at = null;
    }
  }
  if (payload.currentStep !== undefined) updatePayload.current_step = payload.currentStep;
  if (payload.selectedGithubRepositoryId !== undefined) {
    updatePayload.selected_github_repository_id = payload.selectedGithubRepositoryId;
  }
  if (payload.completedSteps !== undefined) updatePayload.completed_steps = payload.completedSteps;
  if (payload.skippedSteps !== undefined) updatePayload.skipped_steps = payload.skippedSteps;

  return updatePayload;
}
