import "server-only";

import { loadWorkspaceGitHubData, type WorkspaceGitHubData } from "@/features/github/data";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables, TablesUpdate } from "@/lib/supabase/database.types";
import {
  type OnboardingSetupHealth,
  type WorkspaceOnboardingState,
  type WorkspaceOnboardingUpdatePayload,
  workspaceOnboardingStatusSchema,
  workspaceOnboardingStepSchema,
} from "@/lib/onboarding/contracts";
import { type WorkspaceAccessContext, requireWorkspaceAccessById } from "@/lib/workspaces/access";

const onboardingSelect =
  "id, workspace_id, status, current_step, completed_steps, skipped_steps, dismissed_at, completed_at, created_at, updated_at";

type OnboardingAccessFailure = {
  error: string;
  ok: false;
  status: 400 | 401 | 403 | 404;
};

export type WorkspaceOnboardingData = {
  canManage: boolean;
  currentMember: {
    id: string;
    role: "admin" | "agent" | "member" | "owner";
  };
  github: WorkspaceGitHubData;
  onboarding: WorkspaceOnboardingState;
  setupHealth: OnboardingSetupHealth;
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
};

type OnboardingDataResult =
  | {
      data: WorkspaceOnboardingData;
      ok: true;
    }
  | OnboardingAccessFailure;

type SandboxCapabilityCheckRow = Pick<
  Tables<"sandbox_capability_checks">,
  "capabilities" | "checked_at" | "error_text" | "github_repository_id" | "id" | "status"
>;

function mapOnboardingRow(row: Tables<"workspace_onboarding">): WorkspaceOnboardingState {
  return {
    completedAt: row.completed_at,
    completedSteps: row.completed_steps.map((step) => workspaceOnboardingStepSchema.parse(step)),
    createdAt: row.created_at,
    currentStep: workspaceOnboardingStepSchema.parse(row.current_step),
    dismissedAt: row.dismissed_at,
    id: row.id,
    skippedSteps: row.skipped_steps.map((step) => workspaceOnboardingStepSchema.parse(step)),
    status: workspaceOnboardingStatusSchema.parse(row.status),
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
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
    status:
      row.status === "success" || row.status === "error" || row.status === "running"
        ? row.status
        : "error",
  };
}

function codexConnectionStatus(
  row: { access_token_expires_at: string; updated_at: string } | null,
) {
  if (!row) {
    return {
      connected: false,
      expiresAt: null,
      status: "missing" as const,
      updatedAt: null,
    };
  }

  const expiresAt = new Date(row.access_token_expires_at).getTime();
  const isExpired = Number.isFinite(expiresAt) && expiresAt <= Date.now();

  return {
    connected: !isExpired,
    expiresAt: row.access_token_expires_at,
    status: isExpired ? ("expired" as const) : ("connected" as const),
    updatedAt: row.updated_at,
  };
}

async function loadSetupHealth(
  context: WorkspaceAccessContext,
  github: WorkspaceGitHubData,
): Promise<OnboardingSetupHealth> {
  const admin = createSupabaseAdminClient();
  const workspaceId = context.workspace.id;

  const [
    { data: pipelineRow, error: pipelineError },
    { data: stageRows, error: stageError },
    { data: linearSecret, error: linearSecretError },
    { data: linearRouting, error: linearRoutingError },
    { data: agentConfigRows, error: agentConfigError },
    { data: codexCredentials, error: codexError },
    { data: sandboxRows, error: sandboxError },
  ] = await Promise.all([
    admin
      .from("pipelines")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("is_default", true)
      .maybeSingle(),
    admin.from("pipeline_stages").select("id, pipeline_id").eq("workspace_id", workspaceId),
    admin
      .from("workspace_secrets")
      .select("id, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("key", "LINEAR_API_KEY")
      .maybeSingle(),
    admin
      .from("workspace_linear_routing")
      .select("id, updated_at")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    admin.from("workspace_agent_config").select("key").eq("workspace_id", workspaceId),
    admin
      .from("user_codex_credentials")
      .select("access_token_expires_at, updated_at")
      .eq("user_id", context.user.id)
      .maybeSingle(),
    admin
      .from("sandbox_capability_checks")
      .select("id, github_repository_id, status, capabilities, error_text, checked_at")
      .eq("workspace_id", workspaceId)
      .order("checked_at", { ascending: false })
      .limit(1),
  ]);

  const firstError =
    pipelineError ??
    stageError ??
    linearSecretError ??
    linearRoutingError ??
    agentConfigError ??
    codexError ??
    sandboxError;
  if (firstError) throw firstError;

  const stageCount = pipelineRow
    ? (stageRows ?? []).filter((stage) => stage.pipeline_id === pipelineRow.id).length
    : 0;
  const configuredKeys = [...new Set((agentConfigRows ?? []).map((row) => row.key))].sort();
  const linearRoutingUpdatedAt =
    typeof linearRouting?.updated_at === "string" ? linearRouting.updated_at : null;
  const repositoryHealth = buildRepositorySetupHealth(github);

  return {
    agentConfig: {
      configured: configuredKeys.length > 0,
      configuredKeys,
      status: configuredKeys.length > 0 ? "present" : "missing",
    },
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
    ...repositoryHealth,
  };
}

async function buildWorkspaceOnboardingData(
  context: WorkspaceAccessContext,
  options?: {
    onboardingRow?: Tables<"workspace_onboarding">;
  },
): Promise<WorkspaceOnboardingData> {
  let onboardingRow = options?.onboardingRow;

  if (!onboardingRow) {
    const { data, error } = await context.supabase
      .from("workspace_onboarding")
      .select(onboardingSelect)
      .eq("workspace_id", context.workspace.id)
      .single();

    if (error) throw error;
    onboardingRow = data;
  }

  const admin = createSupabaseAdminClient();
  const github = await loadWorkspaceGitHubData(admin, context.workspace.id);

  return {
    canManage: context.currentMember.role === "owner" || context.currentMember.role === "admin",
    currentMember: {
      id: context.currentMember.id,
      role: context.currentMember.role,
    },
    github,
    onboarding: mapOnboardingRow(onboardingRow),
    setupHealth: await loadSetupHealth(context, github),
    workspace: {
      id: context.workspace.id,
      name: context.workspace.name,
      slug: context.workspace.slug,
    },
  };
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
    data: await buildWorkspaceOnboardingData(access.context),
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

  const updatePayload = buildWorkspaceOnboardingUpdatePayload(payload);

  const { data, error } = await access.context.supabase
    .from("workspace_onboarding")
    .update(updatePayload)
    .eq("workspace_id", access.context.workspace.id)
    .select(onboardingSelect)
    .single();

  if (error) throw error;

  return {
    data: await buildWorkspaceOnboardingData(access.context, { onboardingRow: data }),
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
  if (payload.completedSteps !== undefined) updatePayload.completed_steps = payload.completedSteps;
  if (payload.skippedSteps !== undefined) updatePayload.skipped_steps = payload.skippedSteps;

  return updatePayload;
}
