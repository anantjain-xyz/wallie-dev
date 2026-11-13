import "server-only";

import { notFound } from "next/navigation";

import {
  createWorkspaceOnboardingSnapshot,
  type WorkspaceOnboardingData,
} from "@/features/onboarding/data";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";
import { describeRateLimits } from "@/lib/rate-limit";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import { getWorkspaceAvatarUrl } from "@/lib/storage/workspace-avatar";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  mapWorkspaceInvitationRow,
  type WorkspaceInvitation,
  type WorkspaceInvitationRow,
} from "@/lib/workspace-invitations/contracts";
import type { SettingsCategory } from "@/features/settings/settings-categories";

export type AgentConfigMap = WorkspaceOnboardingData["agentConfig"];

export type WorkspaceUsageData = {
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCostUsd: number | null;
  totalRuns: number;
  tokensUnavailable: boolean;
  costUnavailable: boolean;
  hasEstimatedTokens: boolean;
  hasEstimatedCost: boolean;
};

type WorkspaceUsageRow = {
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_runs: number | null;
  tokens_unavailable: boolean | null;
  cost_unavailable: boolean | null;
  has_estimated_tokens: boolean | null;
  has_estimated_cost: boolean | null;
};

export type RateLimitDisplay = {
  endpoint: string;
  description: string;
  windowMs: number;
  max: number;
};

export type SettingsPageData = {
  agentConfig: AgentConfigMap;
  rateLimits: RateLimitDisplay[];
  usage: WorkspaceUsageData;
  canManage: boolean;
  currentMember: {
    id: string;
    role: "admin" | "agent" | "member" | "owner";
  };
  github: WorkspaceOnboardingData["github"];
  latestSandboxCapabilityCheck: WorkspaceOnboardingData["setupHealth"]["latestSandboxCapabilityCheck"];
  linearRouting: WorkspaceOnboardingData["linearRouting"];
  linearSecret: WorkspaceOnboardingData["linearSecret"];
  onboarding: WorkspaceOnboardingData["onboarding"];
  sandboxSettings: WorkspaceOnboardingData["sandboxSettings"];
  setupHealth: WorkspaceOnboardingData["setupHealth"];
  vercelSandboxConnection: WorkspaceOnboardingData["vercelSandboxConnection"];
  workspace: {
    avatarPath: string | null;
    avatarUrl: string | null;
    id: string;
    name: string;
    slug: string;
  };
  workspaceInvitations: WorkspaceInvitation[];
  pipeline: WorkspaceOnboardingData["pipeline"];
  workspaceMembers: WorkspaceOnboardingData["workspaceMembers"];
  workspaceSecrets: WorkspaceOnboardingData["workspaceSecrets"];
};

export type SettingsInitialData = Pick<
  SettingsPageData,
  "canManage" | "currentMember" | "github" | "workspace"
>;

export type SettingsSetupData = Omit<
  SettingsPageData,
  "canManage" | "currentMember" | "github" | "usage" | "workspace" | "workspaceInvitations"
>;

export type SettingsPageDataLoader = {
  initialData: Promise<SettingsInitialData>;
  setupData: Promise<SettingsSetupData>;
  usage: Promise<WorkspaceUsageData>;
  workspaceInvitations: Promise<WorkspaceInvitation[]>;
};

async function loadWorkspaceInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspace_invitations")
    .select(
      "id, workspace_id, email, full_name, role, status, invited_by_member_id, accepted_by_member_id, expires_at, last_sent_at, accepted_at, revoked_at, created_at, updated_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return ((data ?? []) as WorkspaceInvitationRow[]).map(mapWorkspaceInvitationRow);
}

export function mapWorkspaceUsageRow(row: WorkspaceUsageRow | null): WorkspaceUsageData {
  return {
    totalInputTokens: row?.total_input_tokens == null ? null : Number(row.total_input_tokens),
    totalOutputTokens: row?.total_output_tokens == null ? null : Number(row.total_output_tokens),
    totalCostUsd: row?.total_cost_usd == null ? null : Number(row.total_cost_usd),
    totalRuns: Number(row?.total_runs ?? 0),
    tokensUnavailable: row?.tokens_unavailable ?? true,
    costUnavailable: row?.cost_unavailable ?? true,
    hasEstimatedTokens: row?.has_estimated_tokens ?? false,
    hasEstimatedCost: row?.has_estimated_cost ?? false,
  };
}

function observeDeferredSection<T>(promise: Promise<T>): Promise<T> {
  // The page awaits only above-fold data before it renders. Observe failures
  // now so a fast below-fold rejection is handled until React consumes the
  // original promise inside its Suspense boundary.
  void promise.catch(() => undefined);
  return promise;
}

function describeSettingsRateLimits(): RateLimitDisplay[] {
  return describeRateLimits().map((entry) => ({
    description: entry.description,
    endpoint: entry.endpoint,
    max: entry.max,
    windowMs: entry.windowMs,
  }));
}

function createEmptyGitHubOnboardingData(): WorkspaceOnboardingData["github"] {
  return {
    installation: null,
    missingAppKeys: [],
    missingWebhookKeys: [],
    primaryProfile: null,
    repositories: [],
  };
}

function createEmptySettingsSetupData(
  workspaceId: string,
  workspaceMembers: WorkspaceOnboardingData["workspaceMembers"] = [],
): SettingsSetupData {
  return {
    agentConfig: {},
    latestSandboxCapabilityCheck: null,
    linearRouting: DEFAULT_LINEAR_ROUTING_CONFIG,
    linearSecret: null,
    onboarding: {
      completedAt: null,
      completedSteps: [],
      createdAt: "",
      currentStep: "github",
      dismissedAt: null,
      id: "",
      selectedGithubRepositoryId: null,
      skippedSteps: [],
      status: "not_started",
      updatedAt: "",
      workspaceId,
    },
    pipeline: null,
    rateLimits: describeSettingsRateLimits(),
    sandboxSettings: {
      activeProvider: "vercel",
      connections: {
        daytona: null,
        e2b: null,
        vercel: null,
      },
      enabledProviders: [],
      revision: 0,
      updatedAt: null,
    },
    setupHealth: {
      agentConfig: {
        configured: false,
        configuredKeys: [],
        status: "missing",
        values: {},
      },
      claudeCodeConnection: {
        checkedAt: "",
        connected: false,
        status: "missing",
        updatedAt: null,
      },
      codexConnection: {
        accountEmail: null,
        checkedAt: "",
        connected: false,
        credentialType: null,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        status: "missing",
        updatedAt: null,
      },
      defaultPipeline: {
        configured: false,
        pipelineId: null,
        stageCount: 0,
        status: "missing",
      },
      githubInstallation: {
        connected: false,
        installationId: null,
        status: "missing",
        suspended: null,
        targetName: null,
        updatedAt: null,
      },
      latestSandboxCapabilityCheck: null,
      linearKey: {
        configured: false,
        status: "missing",
        updatedAt: null,
      },
      linearRouting: {
        configured: false,
        status: "missing",
        updatedAt: null,
      },
      openCodeConnection: {
        checkedAt: "",
        connected: false,
        providers: [],
        status: "missing",
        updatedAt: null,
      },
      primaryRepositoryProfile: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
      repositorySetup: {
        configured: false,
        repositoryId: null,
        status: "not_set_up",
      },
      selectedRepository: {
        configured: false,
        fullName: null,
        repositoryId: null,
        status: "missing",
      },
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: null,
        projectId: null,
        projectName: null,
        status: "missing",
        teamId: null,
        updatedAt: null,
      },
      workspaceSecrets: {
        configuredKeys: [],
      },
    },
    vercelSandboxConnection: null,
    workspaceMembers,
    workspaceSecrets: [],
  };
}

function mapSettingsSetupData(onboardingData: WorkspaceOnboardingData): SettingsSetupData {
  return {
    agentConfig: onboardingData.agentConfig,
    latestSandboxCapabilityCheck: onboardingData.setupHealth.latestSandboxCapabilityCheck,
    linearRouting: onboardingData.linearRouting,
    linearSecret: onboardingData.linearSecret,
    onboarding: onboardingData.onboarding,
    pipeline: onboardingData.pipeline,
    rateLimits: describeSettingsRateLimits(),
    sandboxSettings: onboardingData.sandboxSettings,
    setupHealth: onboardingData.setupHealth,
    vercelSandboxConnection: onboardingData.vercelSandboxConnection,
    workspaceMembers: onboardingData.workspaceMembers,
    workspaceSecrets: onboardingData.workspaceSecrets,
  };
}

export async function loadSettingsPageData(
  workspaceSlug: string,
  category?: SettingsCategory,
): Promise<SettingsPageDataLoader> {
  return withServerTiming("settings.loader", { workspaceSlug }, async (timing) => {
    const authenticatedContext = await timing.segment(
      "authenticated-workspace-context",
      () => loadAuthenticatedWorkspaceContext(workspaceSlug),
      (context) => ({
        rows: 1,
        workspaceId: context.workspace.id,
      }),
    );
    const { currentMember, supabase, workspace } = authenticatedContext;

    if (!currentMember || !currentMember.is_active || currentMember.kind !== "human") {
      notFound();
    }

    const canManage = currentMember.role === "owner" || currentMember.role === "admin";
    const workspaceSummary = {
      avatarPath: workspace.avatar_path,
      avatarUrl: getWorkspaceAvatarUrl(workspace.avatar_path),
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    };
    const memberSummary = {
      id: currentMember.id,
      role: currentMember.role,
    };

    let initialData: Promise<SettingsInitialData>;
    let setupData: Promise<SettingsSetupData>;

    if (category === "advanced" || category === "workspace") {
      initialData = Promise.resolve({
        canManage,
        currentMember: memberSummary,
        github: createEmptyGitHubOnboardingData(),
        workspace: workspaceSummary,
      });
      setupData =
        category === "advanced"
          ? Promise.resolve(createEmptySettingsSetupData(workspace.id))
          : withServerTiming(
              "settings.section.setup",
              { workspaceId: workspace.id },
              async (sectionTiming) => {
                const { data, error } = await sectionTiming.segment(
                  "workspace-members",
                  () =>
                    supabase
                      .from("workspace_members")
                      .select("id, full_name, email, avatar_url, role")
                      .eq("workspace_id", workspace.id)
                      .eq("kind", "human")
                      .eq("is_active", true)
                      .order("full_name", { ascending: true }),
                  (result) => ({
                    payloadBytes: approximatePayloadSizeBytes(result.data),
                    rows: result.data?.length ?? 0,
                  }),
                );

                if (error) {
                  throw new Error(`Failed to load workspace members: ${error.message}`);
                }

                const workspaceMembers: WorkspaceOnboardingData["workspaceMembers"] = (
                  data ?? []
                ).map((member) => ({
                  avatarUrl: member.avatar_url,
                  email: member.email,
                  fullName: member.full_name,
                  id: member.id,
                  role: member.role,
                }));

                return createEmptySettingsSetupData(workspace.id, workspaceMembers);
              },
            );
    } else {
      const onboardingSnapshot = createWorkspaceOnboardingSnapshot(authenticatedContext);

      initialData = withServerTiming(
        "settings.section.github",
        { workspaceId: workspace.id },
        async (sectionTiming) => {
          const github = await sectionTiming.segment(
            "summary",
            () => onboardingSnapshot.github,
            (value) => ({
              payloadBytes: approximatePayloadSizeBytes(value),
              rows: value.repositories.length,
            }),
          );

          return {
            canManage,
            currentMember: memberSummary,
            github,
            workspace: workspaceSummary,
          };
        },
      );

      setupData = withServerTiming(
        "settings.section.setup",
        { workspaceId: workspace.id },
        async (sectionTiming) => {
          const data = await sectionTiming.segment(
            "canonical-onboarding-snapshot",
            () => onboardingSnapshot.data,
            (value) => ({
              payloadBytes: approximatePayloadSizeBytes(value),
              rows: 1,
            }),
          );
          return mapSettingsSetupData(data);
        },
      );
    }

    const usage =
      category && category !== "advanced"
        ? Promise.resolve(mapWorkspaceUsageRow(null))
        : withServerTiming(
            "settings.section.usage",
            { workspaceId: workspace.id },
            async (sectionTiming) => {
              const { data, error } = await sectionTiming.segment(
                "workspace-usage-rpc",
                () =>
                  supabase
                    .rpc("get_workspace_usage", { target_workspace_id: workspace.id })
                    .maybeSingle(),
                (result) => ({
                  payloadBytes: approximatePayloadSizeBytes(result.data),
                  rows: result.data ? 1 : 0,
                }),
              );

              if (error) throw error;
              return mapWorkspaceUsageRow(data);
            },
          );

    const workspaceInvitations =
      category && category !== "workspace"
        ? Promise.resolve([])
        : withServerTiming(
            "settings.section.invitations",
            { workspaceId: workspace.id },
            async (sectionTiming) => {
              if (!canManage) return [];
              return sectionTiming.segment(
                "pending-invitations",
                () => loadWorkspaceInvitations(workspace.id),
                (invitations) => ({
                  payloadBytes: approximatePayloadSizeBytes(invitations),
                  rows: invitations.length,
                }),
              );
            },
          );

    return {
      initialData,
      setupData: observeDeferredSection(setupData),
      usage: observeDeferredSection(usage),
      workspaceInvitations: observeDeferredSection(workspaceInvitations),
    };
  });
}
