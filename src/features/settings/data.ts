import "server-only";

import { notFound } from "next/navigation";

import { getGitHubConfigStatus } from "@/features/github/config";
import type { PipelineStage, SessionPipeline } from "@/features/sessions/types";
import { getSlackConfigStatus } from "@/features/slack/config";
import { getSlackInstallationForWorkspace } from "@/features/slack/service";
import { normalizeAgentProviderName } from "@/lib/agent-config/contracts";
import { describeRateLimits } from "@/lib/rate-limit";
import { getWorkspaceAvatarUrl } from "@/lib/storage/workspace-avatar";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const workspaceSelect = "id, name, slug, avatar_path";
const currentMemberSelect = "id, role, is_active, kind";
const installationSelect =
  "id, app_id, installation_id, installation_url, permissions, suspended, target_name, target_type, updated_at";
const repositorySelect =
  "id, repo_id, name, full_name, html_url, private, description, default_programming_language, default_branch, is_archived";

export type AgentConfigMap = Record<string, unknown>;

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
  github: {
    installation: {
      appId: number;
      id: string;
      installationId: number;
      installationUrl: string;
      permissions: Record<string, unknown>;
      suspended: boolean;
      targetName: string;
      targetType: string;
      updatedAt: string;
    } | null;
    missingAppKeys: string[];
    missingWebhookKeys: string[];
    repositories: Array<{
      defaultBranch: string | null;
      defaultProgrammingLanguage: string | null;
      description: string | null;
      fullName: string;
      htmlUrl: string;
      id: string;
      isArchived: boolean;
      isPrivate: boolean;
      name: string;
      repoId: number;
    }>;
  };
  slack: {
    installation: {
      id: string;
      installedAt: string;
      teamId: string;
      teamName: string | null;
      updatedAt: string;
    } | null;
    missingAppKeys: string[];
  };
  workspace: {
    avatarPath: string | null;
    avatarUrl: string | null;
    id: string;
    name: string;
    slug: string;
  };
  pipeline: SessionPipeline | null;
  workspaceMembers: Array<{
    id: string;
    fullName: string | null;
    email: string | null;
    role: "owner" | "admin" | "member" | "agent";
  }>;
};

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

  const [
    { data: currentMember, error: currentMemberError },
    { data: installationRows, error: installationError },
    { data: repositoryRows, error: repositoryError },
  ] = await Promise.all([
    supabase
      .from("workspace_members")
      .select(currentMemberSelect)
      .eq("workspace_id", workspace.id)
      .eq("user_id", user.id)
      .maybeSingle(),
    supabase
      .from("github_installations")
      .select(installationSelect)
      .eq("workspace_id", workspace.id)
      .order("updated_at", { ascending: false })
      .limit(1),
    supabase
      .from("github_repositories")
      .select(repositorySelect)
      .eq("workspace_id", workspace.id)
      .order("full_name", { ascending: true }),
  ]);

  if (currentMemberError) {
    throw currentMemberError;
  }

  if (installationError) {
    throw installationError;
  }

  if (repositoryError) {
    throw repositoryError;
  }

  if (!currentMember || !currentMember.is_active) {
    notFound();
  }

  const installation = installationRows?.[0] ?? null;
  const slackInstallation = await getSlackInstallationForWorkspace(workspace.id);

  // Load agent config (visible to managers only, but load for everyone to
  // populate read-only display if needed).
  const { data: agentConfigRows } = await supabase
    .from("workspace_agent_config")
    .select("key, value_json")
    .eq("workspace_id", workspace.id);

  const agentConfig: AgentConfigMap = {};
  for (const row of agentConfigRows ?? []) {
    agentConfig[row.key] =
      row.key === "agent_provider" && typeof row.value_json === "string"
        ? (normalizeAgentProviderName(row.value_json) ?? row.value_json)
        : row.value_json;
  }

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

  const canManage = currentMember.role === "owner" || currentMember.role === "admin";

  // Load the workspace's default pipeline + stages for the PipelineEditor.
  const { data: pipelineRow } = await supabase
    .from("pipelines")
    .select("id, name, is_default")
    .eq("workspace_id", workspace.id)
    .eq("is_default", true)
    .maybeSingle();

  let pipeline: SessionPipeline | null = null;
  if (pipelineRow) {
    const { data: stageRows } = await supabase
      .from("pipeline_stages")
      .select(
        "id, pipeline_id, position, slug, name, description, prompt_template_md, approver_member_ids",
      )
      .eq("pipeline_id", pipelineRow.id)
      .order("position", { ascending: true });

    const stages: PipelineStage[] = (stageRows ?? []).map((s) => ({
      approverMemberIds: s.approver_member_ids ?? [],
      description: s.description,
      id: s.id,
      name: s.name,
      pipelineId: s.pipeline_id,
      position: s.position,
      promptTemplateMd: s.prompt_template_md,
      slug: s.slug,
    }));

    pipeline = {
      id: pipelineRow.id,
      isDefault: pipelineRow.is_default,
      name: pipelineRow.name,
      stages,
    };
  }

  // Members are needed to render the per-stage approver picker. Restrict to
  // human members so the system "wallie" agent doesn't show up as a possible
  // approver.
  const { data: memberRows } = await supabase
    .from("workspace_members")
    .select("id, full_name, email, role, kind, is_active")
    .eq("workspace_id", workspace.id)
    .eq("kind", "human")
    .eq("is_active", true)
    .order("full_name", { ascending: true });

  const workspaceMembers = (memberRows ?? []).map((m) => ({
    email: m.email,
    fullName: m.full_name,
    id: m.id,
    role: m.role as "owner" | "admin" | "member" | "agent",
  }));

  const rateLimits: RateLimitDisplay[] = describeRateLimits().map((entry) => ({
    description: entry.description,
    endpoint: entry.endpoint,
    max: entry.max,
    windowMs: entry.windowMs,
  }));

  return {
    agentConfig,
    canManage,
    rateLimits,
    usage,
    currentMember: {
      id: currentMember.id,
      role: currentMember.role,
    },
    github: {
      installation: installation
        ? {
            appId: installation.app_id,
            id: installation.id,
            installationId: installation.installation_id,
            installationUrl: installation.installation_url,
            permissions: (installation.permissions ?? {}) as Record<string, unknown>,
            suspended: installation.suspended,
            targetName: installation.target_name,
            targetType: installation.target_type,
            updatedAt: installation.updated_at,
          }
        : null,
      ...getGitHubConfigStatus(),
      repositories: (repositoryRows ?? []).map((repository) => ({
        defaultBranch: repository.default_branch,
        defaultProgrammingLanguage: repository.default_programming_language,
        description: repository.description,
        fullName: repository.full_name,
        htmlUrl: repository.html_url,
        id: repository.id,
        isArchived: repository.is_archived,
        isPrivate: repository.private,
        name: repository.name,
        repoId: repository.repo_id,
      })),
    },
    slack: {
      installation: slackInstallation,
      ...getSlackConfigStatus(),
    },
    workspace: {
      avatarPath: workspace.avatar_path,
      avatarUrl: getWorkspaceAvatarUrl(workspace.avatar_path),
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
    },
    pipeline,
    workspaceMembers,
  } satisfies SettingsPageData;
}
