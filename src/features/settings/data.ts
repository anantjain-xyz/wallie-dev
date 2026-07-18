import "server-only";

import { notFound } from "next/navigation";

import {
  createWorkspaceOnboardingSnapshot,
  type WorkspaceOnboardingData,
} from "@/features/onboarding/data";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { describeRateLimits } from "@/lib/rate-limit";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import { getWorkspaceAvatarUrl } from "@/lib/storage/workspace-avatar";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";
import {
  mapWorkspaceInvitationRow,
  type WorkspaceInvitation,
  type WorkspaceInvitationRow,
} from "@/lib/workspace-invitations/contracts";

const currentMemberSelect = "id, role, is_active, kind";

export type AgentConfigMap = WorkspaceOnboardingData["agentConfig"];

export type WorkspaceUsageData = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalRuns: number;
};

type WorkspaceUsageRow = {
  total_cost_usd: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_runs: number | null;
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
      "id, workspace_id, email, role, status, invited_by_member_id, accepted_by_member_id, expires_at, last_sent_at, accepted_at, revoked_at, created_at, updated_at",
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
    totalInputTokens: Number(row?.total_input_tokens ?? 0),
    totalOutputTokens: Number(row?.total_output_tokens ?? 0),
    totalCostUsd: Number(row?.total_cost_usd ?? 0),
    totalRuns: Number(row?.total_runs ?? 0),
  };
}

function observeDeferredSection<T>(promise: Promise<T>): Promise<T> {
  // The page awaits only above-fold data before it renders. Observe failures
  // now so a fast below-fold rejection is handled until React consumes the
  // original promise inside its Suspense boundary.
  void promise.catch(() => undefined);
  return promise;
}

function mapSettingsSetupData(onboardingData: WorkspaceOnboardingData): SettingsSetupData {
  return {
    agentConfig: onboardingData.agentConfig,
    latestSandboxCapabilityCheck: onboardingData.setupHealth.latestSandboxCapabilityCheck,
    linearRouting: onboardingData.linearRouting,
    linearSecret: onboardingData.linearSecret,
    onboarding: onboardingData.onboarding,
    pipeline: onboardingData.pipeline,
    rateLimits: describeRateLimits().map((entry) => ({
      description: entry.description,
      endpoint: entry.endpoint,
      max: entry.max,
      windowMs: entry.windowMs,
    })),
    setupHealth: onboardingData.setupHealth,
    vercelSandboxConnection: onboardingData.vercelSandboxConnection,
    workspaceMembers: onboardingData.workspaceMembers,
    workspaceSecrets: onboardingData.workspaceSecrets,
  };
}

export async function loadSettingsPageData(workspaceSlug: string): Promise<SettingsPageDataLoader> {
  return withServerTiming("settings.loader", { workspaceSlug }, async (timing) => {
    const authenticatedContext = await timing.segment(
      "authenticated-workspace-context",
      () => loadAuthenticatedWorkspaceContext(workspaceSlug),
      (context) => ({
        rows: 1,
        workspaceId: context.workspace.id,
      }),
    );
    const { supabase, user, workspace } = authenticatedContext;

    const { data: currentMember, error: currentMemberError } = await timing.segment(
      "current-member",
      () =>
        supabase
          .from("workspace_members")
          .select(currentMemberSelect)
          .eq("workspace_id", workspace.id)
          .eq("user_id", user.id)
          .maybeSingle(),
      (result) => ({ rows: result.data ? 1 : 0 }),
    );

    if (currentMemberError) {
      throw currentMemberError;
    }

    if (!currentMember || !currentMember.is_active || currentMember.kind !== "human") {
      notFound();
    }

    const canManage = currentMember.role === "owner" || currentMember.role === "admin";
    const accessContext: WorkspaceAccessContext = {
      currentMember,
      supabase,
      user,
      workspace,
    };
    const onboardingSnapshot = createWorkspaceOnboardingSnapshot(accessContext);
    const workspaceSummary = {
      avatarPath: workspace.avatar_path,
      avatarUrl: getWorkspaceAvatarUrl(workspace.avatar_path),
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    };

    const initialData = withServerTiming(
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
          currentMember: {
            id: currentMember.id,
            role: currentMember.role,
          },
          github,
          workspace: workspaceSummary,
        };
      },
    );

    const setupData = withServerTiming(
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

    const usage = withServerTiming(
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

    const workspaceInvitations = withServerTiming(
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
