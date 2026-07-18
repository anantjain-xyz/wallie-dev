import "server-only";

import { cache } from "react";

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
import {
  coerceLinearRoutingConfig,
  DEFAULT_LINEAR_ROUTING_CONFIG,
  type LinearRoutingConfig,
} from "@/lib/linear-routing/contracts";
import { credentialExpired, isCodexCredentialType } from "@/lib/codex/contracts";
import type { SandboxCapabilityCheckState } from "@/lib/sandbox-capabilities/contracts";
import { getLatestSandboxCapabilityCheck } from "@/lib/sandbox-capabilities/server";
import type { WorkspaceSecretPreview } from "@/lib/secrets/contracts";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables, TablesUpdate } from "@/lib/supabase/database.types";
import {
  type OnboardingSetupHealthDelta,
  type OnboardingSetupHealth,
  WORKSPACE_ONBOARDING_STEPS,
  type WorkspaceOnboardingConflictResponse,
  type WorkspaceOnboardingMutationDelta,
  type WorkspaceOnboardingMutationRequest,
  type WorkspaceOnboardingState,
  type WorkspaceOnboardingStep,
  type WorkspaceOnboardingUpdatePayload,
  workspaceOnboardingStatusSchema,
  workspaceOnboardingStepSchema,
} from "@/lib/onboarding/contracts";
import { type WorkspaceAccessContext, requireWorkspaceAccessById } from "@/lib/workspaces/access";
import { loadVercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/server";
import type { VercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/contracts";
import type { AuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

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

type OnboardingMutationResult =
  | {
      data: WorkspaceOnboardingMutationDelta;
      ok: true;
    }
  | OnboardingAccessFailure
  | {
      conflict: WorkspaceOnboardingConflictResponse;
      error: string;
      ok: false;
      status: 409;
    };

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

function mapOnboardingStepState(row: Tables<"workspace_onboarding">) {
  const onboarding = mapOnboardingRow(row);
  return {
    completedAt: onboarding.completedAt,
    completedSteps: onboarding.completedSteps,
    currentStep: onboarding.currentStep,
    dismissedAt: onboarding.dismissedAt,
    selectedGithubRepositoryId: onboarding.selectedGithubRepositoryId,
    skippedSteps: onboarding.skippedSteps,
    status: onboarding.status,
  };
}

async function loadOrCreateOnboardingRow(
  context: {
    supabase: WorkspaceAccessContext["supabase"];
    workspace: { id: string };
  },
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
    account_email: string | null;
    access_token_expires_at: string | null;
    auth_reconnect_reason: string | null;
    auth_reconnect_required: boolean;
    credential_type: string;
    updated_at: string;
  } | null,
  checkedAt: string,
) {
  if (!row || !isCodexCredentialType(row.credential_type)) {
    return {
      accountEmail: null,
      checkedAt,
      connected: false,
      credentialType: null,
      expiresAt: null,
      reconnectReason: null,
      reconnectRequired: false,
      status: "missing" as const,
      updatedAt: null,
    };
  }

  const isExpired = credentialExpired(row.access_token_expires_at);
  const reconnectRequired =
    row.credential_type === "chatgpt_auth_json" && row.auth_reconnect_required;

  return {
    accountEmail: row.account_email,
    checkedAt,
    connected: !isExpired && !reconnectRequired,
    credentialType: row.credential_type,
    expiresAt: row.access_token_expires_at,
    reconnectReason: row.auth_reconnect_reason,
    reconnectRequired,
    status: isExpired || reconnectRequired ? ("expired" as const) : ("connected" as const),
    updatedAt: row.updated_at,
  };
}

function claudeCodeConnectionStatus(row: { updated_at: string } | null, checkedAt: string) {
  if (!row) {
    return {
      checkedAt,
      connected: false,
      status: "missing" as const,
      updatedAt: null,
    };
  }

  return {
    checkedAt,
    connected: true,
    status: "connected" as const,
    updatedAt: row.updated_at,
  };
}

type OnboardingSnapshotContext = Pick<
  AuthenticatedWorkspaceContext,
  "currentMember" | "supabase" | "user" | "workspace"
>;

type PipelineRow = Pick<Tables<"pipelines">, "id" | "is_default" | "name" | "operating_rules_md">;
type PipelineStageRow = Pick<
  Tables<"pipeline_stages">,
  | "approver_member_ids"
  | "description"
  | "id"
  | "name"
  | "pipeline_id"
  | "position"
  | "prompt_template_md"
  | "slug"
>;
type WorkspaceMemberRow = Pick<
  Tables<"workspace_members">,
  "email" | "full_name" | "id" | "is_active" | "kind" | "role" | "user_id"
>;
type LinearRoutingRow = Pick<
  Tables<"workspace_linear_routing">,
  "land_stage_slug" | "rework_stage_slug" | "status_mappings" | "updated_at"
>;

type OnboardingSnapshotRpcName =
  | "load_workspace_onboarding_sandbox_checks"
  | "load_workspace_onboarding_secret_previews";

type OnboardingSnapshotRpcResult = PromiseLike<{
  data: Json | null;
  error: unknown;
}>;

function loadOnboardingSnapshotRows(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  functionName: OnboardingSnapshotRpcName,
  workspaceId: string,
) {
  // These forward-migration RPCs are intentionally not hand-added to generated database.types.ts.
  const rpc = admin.rpc.bind(admin) as unknown as (
    name: OnboardingSnapshotRpcName,
    args: { target_workspace_id: string },
  ) => OnboardingSnapshotRpcResult;

  return rpc(functionName, { target_workspace_id: workspaceId });
}

function snapshotRows<T>(value: Json | null, source: OnboardingSnapshotRpcName): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`Onboarding snapshot RPC ${source} returned a non-array payload.`);
  }
  return value as T[];
}

function secretSnapshotRows(value: Json | null): SecretPreviewRow[] {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(
      "Onboarding snapshot RPC load_workspace_onboarding_secret_previews returned an invalid payload.",
    );
  }

  const secretRows = value.secret_rows;
  const linearSecret = value.linear_secret;
  if (!Array.isArray(secretRows)) {
    throw new Error(
      "Onboarding snapshot RPC load_workspace_onboarding_secret_previews returned invalid secret rows.",
    );
  }

  const rows = secretRows as SecretPreviewRow[];
  if (!linearSecret || Array.isArray(linearSecret) || typeof linearSecret !== "object") {
    return rows;
  }

  const targetedLinearSecret = linearSecret as SecretPreviewRow;
  const existingIndex = rows.findIndex((row) => row.key === "LINEAR_API_KEY");
  if (existingIndex < 0) {
    return [...rows, targetedLinearSecret].sort((left, right) => left.key.localeCompare(right.key));
  }

  return rows.map((row, index) => (index === existingIndex ? targetedLinearSecret : row));
}

type OnboardingSnapshot = {
  agentConfigRows: AgentConfigRow[];
  claudeCodeCredentials: { updated_at: string } | null;
  codexCredentials: {
    account_email: string | null;
    access_token_expires_at: string | null;
    auth_reconnect_reason: string | null;
    auth_reconnect_required: boolean;
    credential_type: string;
    updated_at: string;
  } | null;
  github: WorkspaceGitHubData;
  linearRoutingRow: LinearRoutingRow | null;
  onboardingRow: Tables<"workspace_onboarding">;
  pipelineRow: PipelineRow | null;
  sandboxRows: SandboxCapabilityCheckRow[];
  secretRows: SecretPreviewRow[];
  stageRows: PipelineStageRow[];
  vercelSandboxConnection: VercelSandboxConnectionPreview | null;
  workspaceMemberRows: WorkspaceMemberRow[];
};

function throwQueryError(error: unknown) {
  if (error) throw error;
}

function createOnboardingSnapshot(
  context: OnboardingSnapshotContext,
  options?: { onboardingRow?: Tables<"workspace_onboarding"> },
): { data: Promise<OnboardingSnapshot>; github: Promise<WorkspaceGitHubData> } {
  const admin = createSupabaseAdminClient();
  const workspaceId = context.workspace.id;
  const githubPromise = loadWorkspaceGitHubData(admin, workspaceId);

  const data = withServerTiming("onboarding.snapshot", { workspaceId }, async (timing) => {
    const pipelinePromise = timing.segment("snapshot.pipeline", () =>
      context.supabase
        .from("pipelines")
        .select("id, name, is_default, operating_rules_md")
        .eq("workspace_id", workspaceId)
        .eq("is_default", true)
        .maybeSingle(),
    );
    const stagePromise = pipelinePromise.then((pipelineResult) => {
      throwQueryError(pipelineResult.error);
      const pipelineId = pipelineResult.data?.id ?? "00000000-0000-0000-0000-000000000000";

      return timing.segment("snapshot.stages", () =>
        context.supabase
          .from("pipeline_stages")
          .select(
            "id, pipeline_id, position, slug, name, description, prompt_template_md, approver_member_ids",
          )
          .eq("workspace_id", workspaceId)
          .eq("pipeline_id", pipelineId)
          .order("position", { ascending: true }),
      );
    });

    const [
      onboardingRow,
      github,
      pipelineResult,
      stageResult,
      secretResult,
      routingResult,
      agentConfigResult,
      providerResults,
      sandboxResult,
      vercelSandboxConnection,
      memberResult,
    ] = await Promise.all([
      options?.onboardingRow
        ? Promise.resolve(options.onboardingRow)
        : timing.segment("snapshot.onboarding", () => loadOrCreateOnboardingRow(context, admin)),
      timing.segment(
        "snapshot.github",
        () => githubPromise,
        (result) => ({
          payloadBytes: approximatePayloadSizeBytes(result),
          rows: result.repositories.length + (result.installation ? 1 : 0),
        }),
      ),
      pipelinePromise,
      stagePromise,
      timing.segment("snapshot.secrets", () =>
        loadOnboardingSnapshotRows(admin, "load_workspace_onboarding_secret_previews", workspaceId),
      ),
      timing.segment("snapshot.routing", () =>
        admin
          .from("workspace_linear_routing")
          .select("status_mappings, rework_stage_slug, land_stage_slug, updated_at")
          .eq("workspace_id", workspaceId)
          .maybeSingle(),
      ),
      timing.segment("snapshot.agent-config", () =>
        admin
          .from("workspace_agent_config")
          .select("key, value_json")
          .eq("workspace_id", workspaceId),
      ),
      timing.segment("snapshot.providers", () =>
        Promise.all([
          admin
            .from("user_codex_credentials")
            .select(
              "account_email, access_token_expires_at, auth_reconnect_reason, auth_reconnect_required, credential_type, updated_at",
            )
            .eq("user_id", context.user.id)
            .maybeSingle(),
          admin
            .from("user_claude_code_credentials")
            .select("updated_at")
            .eq("user_id", context.user.id)
            .maybeSingle(),
        ]),
      ),
      timing.segment("snapshot.sandbox", () =>
        loadOnboardingSnapshotRows(admin, "load_workspace_onboarding_sandbox_checks", workspaceId),
      ),
      timing.segment("snapshot.vercel", () =>
        loadVercelSandboxConnectionPreview(admin, workspaceId),
      ),
      timing.segment("snapshot.members", () =>
        context.supabase
          .from("workspace_members")
          .select("id, user_id, full_name, email, role, kind, is_active")
          .eq("workspace_id", workspaceId)
          .eq("kind", "human")
          .eq("is_active", true)
          .order("full_name", { ascending: true }),
      ),
    ]);

    const [codexResult, claudeCodeResult] = providerResults;
    for (const error of [
      pipelineResult.error,
      stageResult.error,
      secretResult.error,
      routingResult.error,
      agentConfigResult.error,
      codexResult.error,
      claudeCodeResult.error,
      sandboxResult.error,
      memberResult.error,
    ]) {
      throwQueryError(error);
    }

    return {
      agentConfigRows: (agentConfigResult.data ?? []) as AgentConfigRow[],
      claudeCodeCredentials: claudeCodeResult.data,
      codexCredentials: codexResult.data,
      github,
      linearRoutingRow: routingResult.data as LinearRoutingRow | null,
      onboardingRow,
      pipelineRow: pipelineResult.data as PipelineRow | null,
      sandboxRows: snapshotRows<SandboxCapabilityCheckRow>(
        sandboxResult.data,
        "load_workspace_onboarding_sandbox_checks",
      ),
      secretRows: secretSnapshotRows(secretResult.data),
      stageRows: (stageResult.data ?? []) as PipelineStageRow[],
      vercelSandboxConnection,
      workspaceMemberRows: (memberResult.data ?? []) as WorkspaceMemberRow[],
    };
  });

  return { data, github: githubPromise };
}

async function buildOnboardingSnapshot(
  context: OnboardingSnapshotContext,
  options?: { onboardingRow?: Tables<"workspace_onboarding"> },
): Promise<OnboardingSnapshot> {
  return createOnboardingSnapshot(context, options).data;
}

const loadOnboardingSnapshot = cache(
  async (workspaceId: string, context: OnboardingSnapshotContext) => {
    if (workspaceId !== context.workspace.id) {
      throw new Error("Onboarding snapshot workspace does not match the authenticated context.");
    }
    return buildOnboardingSnapshot(context);
  },
);

function derivePipeline(snapshot: OnboardingSnapshot): SessionPipeline | null {
  if (!snapshot.pipelineRow) return null;
  const stages: PipelineStage[] = snapshot.stageRows
    .filter((stage) => stage.pipeline_id === snapshot.pipelineRow?.id)
    .map((stage) => ({
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
    id: snapshot.pipelineRow.id,
    isDefault: snapshot.pipelineRow.is_default,
    name: snapshot.pipelineRow.name,
    operatingRulesMd: snapshot.pipelineRow.operating_rules_md ?? "",
    stages,
  };
}

function deriveLinearRouting(row: LinearRoutingRow | null): LinearRoutingConfig {
  if (!row) return DEFAULT_LINEAR_ROUTING_CONFIG;
  return coerceLinearRoutingConfig({
    landStageSlug: row.land_stage_slug,
    reworkStageSlug: row.rework_stage_slug,
    statusMappings: row.status_mappings,
  });
}

function deriveSetupHealth(
  snapshot: OnboardingSnapshot,
  selectedGithubRepositoryId: string | null,
  canManage: boolean,
): OnboardingSetupHealth {
  const repositoryHealth = buildRepositorySetupHealth(snapshot.github, selectedGithubRepositoryId);
  const primaryRepositoryId = repositoryHealth.primaryRepositoryProfile.repositoryId;
  const latestSandboxRow = primaryRepositoryId
    ? snapshot.sandboxRows.find((row) => row.github_repository_id === primaryRepositoryId)
    : snapshot.sandboxRows[0];
  const pipeline = derivePipeline(snapshot);
  const agentConfig = agentConfigEntriesToMap(
    snapshot.agentConfigRows.map((row) => ({ key: row.key, value: row.value_json })),
  );
  const configuredKeys = configuredAgentConfigKeys(agentConfig);
  const secretKeys = [...new Set(snapshot.secretRows.map((row) => row.key))].sort();
  const linearSecret = snapshot.secretRows.find((row) => row.key === "LINEAR_API_KEY") ?? null;
  const linearRoutingUpdatedAt = snapshot.linearRoutingRow?.updated_at ?? null;
  const providerStatusCheckedAt = new Date().toISOString();

  return {
    agentConfig: {
      configured: configuredKeys.length > 0,
      configuredKeys,
      status: configuredKeys.length > 0 ? "present" : "missing",
      values: agentConfig,
    },
    claudeCodeConnection: claudeCodeConnectionStatus(
      snapshot.claudeCodeCredentials,
      providerStatusCheckedAt,
    ),
    codexConnection: codexConnectionStatus(snapshot.codexCredentials, providerStatusCheckedAt),
    defaultPipeline: {
      configured: Boolean(pipeline && pipeline.stages.length > 0),
      pipelineId: pipeline?.id ?? null,
      stageCount: pipeline?.stages.length ?? 0,
      status: pipeline && pipeline.stages.length > 0 ? "ready" : "missing",
    },
    githubInstallation: {
      connected: Boolean(snapshot.github.installation && !snapshot.github.installation.suspended),
      installationId: snapshot.github.installation?.installationId ?? null,
      status: snapshot.github.installation ? "present" : "missing",
      suspended: snapshot.github.installation?.suspended ?? null,
      targetName: snapshot.github.installation?.targetName ?? null,
      updatedAt: snapshot.github.installation?.updatedAt ?? null,
    },
    latestSandboxCapabilityCheck: mapSandboxCapabilityCheck(latestSandboxRow),
    vercelSandboxConnection: snapshot.vercelSandboxConnection
      ? {
          connected: snapshot.vercelSandboxConnection.status === "connected",
          lastValidationError: snapshot.vercelSandboxConnection.lastValidationError,
          projectId: snapshot.vercelSandboxConnection.projectId,
          projectName: snapshot.vercelSandboxConnection.projectName,
          status: snapshot.vercelSandboxConnection.status,
          teamId: snapshot.vercelSandboxConnection.teamId,
          updatedAt: snapshot.vercelSandboxConnection.updatedAt,
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
      configured: Boolean(snapshot.linearRoutingRow),
      status: snapshot.linearRoutingRow ? "present" : "missing",
      updatedAt: linearRoutingUpdatedAt,
    },
    workspaceSecrets: {
      configuredKeys: canManage ? secretKeys : [],
    },
    ...repositoryHealth,
  };
}

function currentMemberFromSnapshot(context: OnboardingSnapshotContext) {
  const member = context.currentMember;
  if (!member || !member.is_active || member.kind !== "human") return null;
  return member;
}

function mapWorkspaceOnboardingData(
  context: OnboardingSnapshotContext,
  snapshot: OnboardingSnapshot,
): WorkspaceOnboardingData | null {
  const currentMember = currentMemberFromSnapshot(context);
  if (!currentMember) return null;

  const onboarding = mapOnboardingRow(snapshot.onboardingRow);
  const canManage = currentMember.role === "owner" || currentMember.role === "admin";
  const workspaceSecrets = canManage ? snapshot.secretRows.map(mapSecretPreview) : [];
  const agentConfig = agentConfigEntriesToMap(
    snapshot.agentConfigRows.map((row) => ({ key: row.key, value: row.value_json })),
  );

  return {
    agentConfig,
    canManage,
    currentMember: { id: currentMember.id, role: currentMember.role },
    github: snapshot.github,
    linearRouting: deriveLinearRouting(snapshot.linearRoutingRow),
    linearSecret: canManage
      ? (workspaceSecrets.find((secret) => secret.key === "LINEAR_API_KEY") ?? null)
      : null,
    onboarding,
    pipeline: derivePipeline(snapshot),
    setupHealth: deriveSetupHealth(snapshot, onboarding.selectedGithubRepositoryId, canManage),
    vercelSandboxConnection: snapshot.vercelSandboxConnection,
    workspace: {
      id: context.workspace.id,
      name: context.workspace.name,
      slug: context.workspace.slug,
    },
    workspaceMembers: snapshot.workspaceMemberRows.map((member) => ({
      email: member.email,
      fullName: member.full_name,
      id: member.id,
      role: member.role as WorkspaceMemberSummary["role"],
    })),
    workspaceSecrets,
  };
}

async function buildWorkspaceOnboardingData(
  context: OnboardingSnapshotContext,
  options?: { onboardingRow?: Tables<"workspace_onboarding">; requestCached?: boolean },
): Promise<WorkspaceOnboardingData | null> {
  const snapshot = options?.requestCached
    ? await loadOnboardingSnapshot(context.workspace.id, context)
    : await buildOnboardingSnapshot(context, { onboardingRow: options?.onboardingRow });
  return mapWorkspaceOnboardingData(context, snapshot);
}

export function createWorkspaceOnboardingSnapshot(
  context: AuthenticatedWorkspaceContext,
): WorkspaceOnboardingSnapshot {
  const snapshot = createOnboardingSnapshot(context);
  const data = snapshot.data.then((value) => {
    const onboardingData = mapWorkspaceOnboardingData(context, value);
    if (!onboardingData) {
      throw new Error("Authenticated workspace context has no active human member.");
    }
    return onboardingData;
  });

  return { data, github: snapshot.github };
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

  const data = await buildWorkspaceOnboardingData(access.context, { requestCached: true });
  if (!data) return { error: "Workspace not found.", ok: false, status: 404 };
  return { data, ok: true };
}

export async function loadWorkspaceOnboardingDataForContext(
  context: AuthenticatedWorkspaceContext,
): Promise<OnboardingDataResult> {
  const data = await buildWorkspaceOnboardingData(context, { requestCached: true });
  if (!data) return { error: "Workspace not found.", ok: false, status: 404 };
  return { data, ok: true };
}

async function loadRepositorySelectionHealthDelta(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
  selectedRepositoryId: string | null,
): Promise<OnboardingSetupHealthDelta> {
  if (!selectedRepositoryId) {
    return {
      latestSandboxCapabilityCheck: null,
      primaryRepositoryProfile: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
      repositorySetup: {
        configured: false,
        repositoryId: null,
        status: "placeholder",
      },
      selectedRepository: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
    };
  }

  const [repositoryResult, profileResult, setupResult, latestSandboxCapabilityCheck] =
    await Promise.all([
      admin
        .from("github_repositories")
        .select("id, full_name, is_archived")
        .eq("workspace_id", workspaceId)
        .eq("id", selectedRepositoryId)
        .maybeSingle(),
      admin
        .from("workspace_repository_profiles")
        .select("github_repository_id")
        .eq("workspace_id", workspaceId)
        .eq("is_primary", true)
        .maybeSingle(),
      admin
        .from("repository_onboarding_status")
        .select("github_repository_id, status")
        .eq("workspace_id", workspaceId)
        .eq("github_repository_id", selectedRepositoryId)
        .maybeSingle(),
      getLatestSandboxCapabilityCheck({
        admin,
        repositoryId: selectedRepositoryId,
        workspaceId,
      }),
    ]);

  const firstError = repositoryResult.error ?? profileResult.error ?? setupResult.error;
  if (firstError) throw firstError;

  const repository =
    repositoryResult.data && !repositoryResult.data.is_archived ? repositoryResult.data : null;
  const primaryProfileMatches =
    Boolean(repository) && profileResult.data?.github_repository_id === selectedRepositoryId;
  const setupStatus = repository ? setupResult.data?.status : undefined;
  const repositorySetupStatus =
    setupStatus === "not_set_up" ||
    setupStatus === "pr_open" ||
    setupStatus === "ready" ||
    setupStatus === "conflict" ||
    setupStatus === "error"
      ? setupStatus
      : "placeholder";

  return {
    latestSandboxCapabilityCheck,
    primaryRepositoryProfile: {
      configured: primaryProfileMatches,
      fullName: primaryProfileMatches ? (repository?.full_name ?? null) : null,
      repositoryId: primaryProfileMatches ? selectedRepositoryId : null,
      status: primaryProfileMatches ? "ready" : "missing",
    },
    repositorySetup: {
      configured: repositorySetupStatus === "ready",
      repositoryId: repository ? selectedRepositoryId : null,
      status: repositorySetupStatus,
    },
    selectedRepository: {
      configured: Boolean(repository),
      fullName: repository?.full_name ?? null,
      repositoryId: repository?.id ?? null,
      status: repository ? "ready" : "missing",
    },
  };
}

async function mutationSetupHealthDelta(input: {
  action: WorkspaceOnboardingMutationRequest["action"] | "complete";
  admin: ReturnType<typeof createSupabaseAdminClient>;
  row: Tables<"workspace_onboarding">;
  workspaceId: string;
}) {
  return input.action === "repository-selection"
    ? loadRepositorySelectionHealthDelta(
        input.admin,
        input.workspaceId,
        input.row.selected_github_repository_id,
      )
    : {};
}

async function buildOnboardingConflict(input: {
  action: WorkspaceOnboardingMutationRequest["action"] | "complete";
  admin: ReturnType<typeof createSupabaseAdminClient>;
  row: Tables<"workspace_onboarding">;
  step: WorkspaceOnboardingStep;
  workspaceId: string;
}): Promise<WorkspaceOnboardingConflictResponse> {
  const setupHealth = await loadRepositorySelectionHealthDelta(
    input.admin,
    input.workspaceId,
    input.row.selected_github_repository_id,
  );
  return {
    action: input.action,
    authoritative: {
      onboarding: mapOnboardingStepState(input.row),
      setupHealth,
      updatedAt: input.row.updated_at,
    },
    error:
      "Onboarding changed in another session. Latest progress was restored; retry your action.",
    kind: "onboarding-conflict",
    retryable: true,
    step: input.step,
    validationErrors: [],
  };
}

async function buildOnboardingMutationDelta(input: {
  action: WorkspaceOnboardingMutationRequest["action"] | "complete";
  admin: ReturnType<typeof createSupabaseAdminClient>;
  row: Tables<"workspace_onboarding">;
  step: WorkspaceOnboardingStep;
  workspaceId: string;
}): Promise<WorkspaceOnboardingMutationDelta> {
  return {
    action: input.action,
    kind: "onboarding-mutation",
    onboarding: mapOnboardingStepState(input.row),
    setupHealth: await mutationSetupHealthDelta(input),
    step: input.step,
    updatedAt: input.row.updated_at,
    validationErrors: [],
  };
}

export async function updateWorkspaceOnboardingData(
  workspaceId: string,
  request: WorkspaceOnboardingMutationRequest,
): Promise<OnboardingMutationResult> {
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

  if (currentRow.updated_at !== request.expectedUpdatedAt) {
    const conflict = await buildOnboardingConflict({
      action: request.action,
      admin,
      row: currentRow,
      step: request.step,
      workspaceId: access.context.workspace.id,
    });
    return { conflict, error: conflict.error, ok: false, status: 409 };
  }

  const normalizedPayload = await normalizeWorkspaceOnboardingUpdatePayload({
    admin,
    currentRow,
    payload: request.changes,
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
    .eq("updated_at", request.expectedUpdatedAt)
    .select(onboardingSelect)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const { data: authoritativeRow, error: authoritativeError } = await access.context.supabase
      .from("workspace_onboarding")
      .select(onboardingSelect)
      .eq("workspace_id", access.context.workspace.id)
      .single();
    if (authoritativeError) throw authoritativeError;
    const conflict = await buildOnboardingConflict({
      action: request.action,
      admin,
      row: authoritativeRow,
      step: request.step,
      workspaceId: access.context.workspace.id,
    });
    return { conflict, error: conflict.error, ok: false, status: 409 };
  }

  return {
    data: await buildOnboardingMutationDelta({
      action: request.action,
      admin,
      row: data,
      step: request.step,
      workspaceId: access.context.workspace.id,
    }),
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
      data: WorkspaceOnboardingMutationDelta;
      ok: true;
    }
  | {
      blockers?: VerifyBlocker[];
      conflict?: WorkspaceOnboardingConflictResponse;
      error: string;
      ok: false;
      status: 400 | 401 | 403 | 404 | 409;
    };

export async function completeWorkspaceOnboarding(
  workspaceId: string,
  expectedUpdatedAt: string,
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

  const admin = createSupabaseAdminClient();
  if (onboardingRow.updated_at !== expectedUpdatedAt) {
    const conflict = await buildOnboardingConflict({
      action: "complete",
      admin,
      row: onboardingRow,
      step: "verify",
      workspaceId: access.context.workspace.id,
    });
    return { conflict, error: conflict.error, ok: false, status: 409 };
  }

  const currentData = await buildWorkspaceOnboardingData(access.context, { onboardingRow });
  if (!currentData) {
    return { error: "Workspace not found.", ok: false, status: 404 };
  }
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
    .eq("updated_at", expectedUpdatedAt)
    .select(onboardingSelect)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const { data: authoritativeRow, error: authoritativeError } = await access.context.supabase
      .from("workspace_onboarding")
      .select(onboardingSelect)
      .eq("workspace_id", access.context.workspace.id)
      .single();
    if (authoritativeError) throw authoritativeError;
    const conflict = await buildOnboardingConflict({
      action: "complete",
      admin,
      row: authoritativeRow,
      step: "verify",
      workspaceId: access.context.workspace.id,
    });
    return { conflict, error: conflict.error, ok: false, status: 409 };
  }

  return {
    data: await buildOnboardingMutationDelta({
      action: "complete",
      admin,
      row: data,
      step: "verify",
      workspaceId: access.context.workspace.id,
    }),
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
