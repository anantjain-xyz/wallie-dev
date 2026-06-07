import "server-only";

import { notFound } from "next/navigation";

import {
  loadWorkspaceOnboardingData,
  type WorkspaceOnboardingData,
} from "@/features/onboarding/data";
import { describeRateLimits } from "@/lib/rate-limit";
import { getWorkspaceAvatarUrl } from "@/lib/storage/workspace-avatar";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  mapWorkspaceInvitationRow,
  type WorkspaceInvitation,
  type WorkspaceInvitationRow,
} from "@/lib/workspace-invitations/contracts";

const workspaceSelect = "id, name, slug, avatar_path";
const currentMemberSelect = "id, role, is_active, kind";

export type AgentConfigMap = WorkspaceOnboardingData["agentConfig"];

export type WorkspaceUsageData = {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  totalRuns: number;
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

export async function loadSettingsPageData(workspaceSlug: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    notFound();
  }

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select(workspaceSelect)
    .eq("slug", workspaceSlug)
    .maybeSingle();

  if (workspaceError) {
    throw workspaceError;
  }

  if (!workspace) {
    notFound();
  }

  const { data: currentMember, error: currentMemberError } = await supabase
    .from("workspace_members")
    .select(currentMemberSelect)
    .eq("workspace_id", workspace.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (currentMemberError) {
    throw currentMemberError;
  }

  if (!currentMember || !currentMember.is_active) {
    notFound();
  }

  const onboardingResult = await loadWorkspaceOnboardingData(workspace.id);
  if (!onboardingResult.ok) {
    notFound();
  }
  const onboardingData = onboardingResult.data;
  const workspaceInvitations = onboardingData.canManage
    ? await loadWorkspaceInvitations(workspace.id)
    : [];

  // Load aggregate token usage for the workspace.
  const { data: usageRows } = await supabase
    .from("agent_runs")
    .select("input_tokens, output_tokens, total_cost_usd")
    .eq("workspace_id", workspace.id)
    .eq("status", "success");

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  const totalRuns = (usageRows ?? []).length;

  for (const row of usageRows ?? []) {
    totalInputTokens += row.input_tokens ?? 0;
    totalOutputTokens += row.output_tokens ?? 0;
    totalCostUsd += row.total_cost_usd ?? 0;
  }

  const usage: WorkspaceUsageData = {
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    totalRuns,
  };

  const rateLimits: RateLimitDisplay[] = describeRateLimits().map((entry) => ({
    description: entry.description,
    endpoint: entry.endpoint,
    max: entry.max,
    windowMs: entry.windowMs,
  }));

  return {
    agentConfig: onboardingData.agentConfig,
    canManage: onboardingData.canManage,
    rateLimits,
    usage,
    currentMember: onboardingData.currentMember,
    github: onboardingData.github,
    latestSandboxCapabilityCheck: onboardingData.setupHealth.latestSandboxCapabilityCheck,
    linearRouting: onboardingData.linearRouting,
    linearSecret: onboardingData.linearSecret,
    onboarding: onboardingData.onboarding,
    setupHealth: onboardingData.setupHealth,
    vercelSandboxConnection: onboardingData.vercelSandboxConnection,
    workspace: {
      avatarPath: workspace.avatar_path,
      avatarUrl: getWorkspaceAvatarUrl(workspace.avatar_path),
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    },
    workspaceInvitations,
    pipeline: onboardingData.pipeline,
    workspaceMembers: onboardingData.workspaceMembers,
    workspaceSecrets: onboardingData.workspaceSecrets,
  } satisfies SettingsPageData;
}
