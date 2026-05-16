import "server-only";

import type { WorkspaceMemberSummary } from "@/features/pipeline/editor-primitives";
import type { PipelineStage, SessionPipeline } from "@/features/sessions/types";
import type { LinearRoutingConfig } from "@/lib/linear-routing/contracts";
import { loadLinearRoutingConfig } from "@/lib/linear-routing/server";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";
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
  onboarding: WorkspaceOnboardingState;
  linearRouting: LinearRoutingConfig;
  linearSecret: WorkspaceSecretPreview | null;
  pipeline: SessionPipeline | null;
  setupHealth: OnboardingSetupHealth;
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
  workspaceMembers: WorkspaceMemberSummary[];
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
  admin = createSupabaseAdminClient(),
): Promise<OnboardingSetupHealth> {
  const workspaceId = context.workspace.id;

  const [
    { data: installationRows, error: installationError },
    { data: pipelineRow, error: pipelineError },
    { data: stageRows, error: stageError },
    { data: linearSecret, error: linearSecretError },
    { data: linearRouting, error: linearRoutingError },
    { data: agentConfigRows, error: agentConfigError },
    { data: codexCredentials, error: codexError },
    { data: sandboxRows, error: sandboxError },
  ] = await Promise.all([
    admin
      .from("github_installations")
      .select("installation_id, suspended, target_name, updated_at")
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(1),
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
    installationError ??
    pipelineError ??
    stageError ??
    linearSecretError ??
    linearRoutingError ??
    agentConfigError ??
    codexError ??
    sandboxError;
  if (firstError) throw firstError;

  const installation = installationRows?.[0] ?? null;
  const stageCount = pipelineRow
    ? (stageRows ?? []).filter((stage) => stage.pipeline_id === pipelineRow.id).length
    : 0;
  const configuredKeys = [...new Set((agentConfigRows ?? []).map((row) => row.key))].sort();
  const linearRoutingUpdatedAt =
    typeof linearRouting?.updated_at === "string" ? linearRouting.updated_at : null;

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
      connected: Boolean(installation && !installation.suspended),
      installationId: installation?.installation_id ?? null,
      status: installation ? "present" : "missing",
      suspended: installation?.suspended ?? null,
      targetName: installation?.target_name ?? null,
      updatedAt: installation?.updated_at ?? null,
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
    primaryRepositoryProfile: {
      configured: false,
      fullName: null,
      repositoryId: null,
      status: "placeholder",
    },
    repositorySetup: {
      configured: false,
      repositoryId: null,
      status: "placeholder",
    },
  };
}

async function loadDefaultPipeline(
  context: WorkspaceAccessContext,
): Promise<SessionPipeline | null> {
  const { data: pipelineRow, error: pipelineError } = await context.supabase
    .from("pipelines")
    .select("id, name, is_default")
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

  return {
    createdAt: data.created_at,
    createdByMemberId: data.created_by_member_id,
    id: data.id,
    key: data.key,
    updatedAt: data.updated_at,
    valuePreview: data.value_preview,
    workspaceId: data.workspace_id,
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

  const canManage =
    context.currentMember.role === "owner" || context.currentMember.role === "admin";
  const admin = createSupabaseAdminClient();
  const [setupHealth, pipeline, workspaceMembers, linearRouting, linearSecret] = await Promise.all([
    loadSetupHealth(context, admin),
    loadDefaultPipeline(context),
    loadWorkspaceMembers(context),
    loadLinearRoutingConfig(admin, context.workspace.id),
    canManage ? loadLinearSecretPreview(admin, context.workspace.id) : Promise.resolve(null),
  ]);

  return {
    canManage,
    currentMember: {
      id: context.currentMember.id,
      role: context.currentMember.role,
    },
    linearRouting,
    linearSecret,
    onboarding: mapOnboardingRow(onboardingRow),
    pipeline,
    setupHealth,
    workspace: {
      id: context.workspace.id,
      name: context.workspace.name,
      slug: context.workspace.slug,
    },
    workspaceMembers,
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
