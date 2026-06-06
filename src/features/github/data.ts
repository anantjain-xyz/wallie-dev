import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getGitHubConfigStatus } from "@/features/github/config";
import type {
  GitHubInstallationSummary,
  GitHubRepositorySummary,
} from "@/features/github/contracts";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import { mapRepositoryProfileRow } from "@/lib/repo-inference/server";
import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

const installationSelect =
  "id, app_id, installation_id, installation_url, permissions, suspended, target_name, target_type, updated_at";
const repositorySelect =
  "id, repo_id, name, full_name, html_url, private, description, default_programming_language, default_branch, is_archived";
const onboardingSelect =
  "github_repository_id, status, setup_branch_name, setup_pr_number, setup_pr_url, installed_skill_version, installed_skill_hash, conflict_report, last_error, updated_at";
const profileSelect =
  "id, workspace_id, github_repository_id, is_primary, package_manager, language_hints, framework_hints, install_command, build_command, test_command, env_key_suggestions, setup_notes, inference_confidence, inference_sources, created_at, updated_at";

type InstallationRow = Pick<
  Tables<"github_installations">,
  | "app_id"
  | "id"
  | "installation_id"
  | "installation_url"
  | "permissions"
  | "suspended"
  | "target_name"
  | "target_type"
  | "updated_at"
>;

type RepositoryRow = Pick<
  Tables<"github_repositories">,
  | "default_branch"
  | "default_programming_language"
  | "description"
  | "full_name"
  | "html_url"
  | "id"
  | "is_archived"
  | "name"
  | "private"
  | "repo_id"
>;

type OnboardingRow = {
  conflict_report: unknown;
  github_repository_id: string;
  installed_skill_hash: string | null;
  installed_skill_version: number | null;
  last_error: string | null;
  setup_branch_name: string | null;
  setup_pr_number: number | null;
  setup_pr_url: string | null;
  status: unknown;
  updated_at: string | null;
};

export type WorkspaceGitHubRepository = GitHubRepositorySummary & {
  onboarding: RepositoryOnboardingState;
  profile: RepositoryProfileState | null;
};

export type WorkspaceGitHubData = {
  installation: GitHubInstallationSummary | null;
  missingAppKeys: string[];
  missingWebhookKeys: string[];
  // Temporary compatibility: repository profiles are still sourced from the legacy is_primary row.
  primaryProfile: RepositoryProfileState | null;
  repositories: WorkspaceGitHubRepository[];
};

function mapInstallation(row: InstallationRow): GitHubInstallationSummary {
  return {
    appId: row.app_id,
    id: row.id,
    installationId: row.installation_id,
    installationUrl: row.installation_url,
    permissions: (row.permissions ?? {}) as Record<string, unknown>,
    suspended: row.suspended,
    targetName: row.target_name,
    targetType: row.target_type,
    updatedAt: row.updated_at,
  };
}

function mapRepository(row: RepositoryRow): GitHubRepositorySummary {
  return {
    defaultBranch: row.default_branch,
    defaultProgrammingLanguage: row.default_programming_language,
    description: row.description,
    fullName: row.full_name,
    htmlUrl: row.html_url,
    id: row.id,
    isArchived: row.is_archived,
    isPrivate: row.private,
    name: row.name,
    repoId: row.repo_id,
  };
}

export function defaultRepositoryOnboarding(repositoryId: string): RepositoryOnboardingState {
  return {
    conflictReport: [],
    githubRepositoryId: repositoryId,
    installedSkillHash: null,
    installedSkillVersion: null,
    lastError: null,
    setupBranchName: null,
    setupPrNumber: null,
    setupPrUrl: null,
    status: "not_set_up",
    updatedAt: null,
  };
}

function mapRepositoryOnboardingState(
  row: OnboardingRow | undefined,
  repositoryId: string,
): RepositoryOnboardingState {
  const conflictReport = Array.isArray(row?.conflict_report) ? row.conflict_report : [];
  const status = row?.status;
  return {
    conflictReport: conflictReport as RepositoryOnboardingState["conflictReport"],
    githubRepositoryId: repositoryId,
    installedSkillHash: row?.installed_skill_hash ?? null,
    installedSkillVersion: row?.installed_skill_version ?? null,
    lastError: row?.last_error ?? null,
    setupBranchName: row?.setup_branch_name ?? null,
    setupPrNumber: row?.setup_pr_number ?? null,
    setupPrUrl: row?.setup_pr_url ?? null,
    status:
      status === "pr_open" ||
      status === "ready" ||
      status === "conflict" ||
      status === "error" ||
      status === "not_set_up"
        ? status
        : "not_set_up",
    updatedAt: row?.updated_at ?? null,
  };
}

export async function loadWorkspaceGitHubData(
  admin: AdminClient,
  workspaceId: string,
): Promise<WorkspaceGitHubData> {
  const [
    { data: installationRows, error: installationError },
    { data: repositoryRows, error: repositoryError },
    { data: onboardingRows, error: onboardingError },
    { data: profileRows, error: profileError },
  ] = await Promise.all([
    admin
      .from("github_installations")
      .select(installationSelect)
      .eq("workspace_id", workspaceId)
      .order("updated_at", { ascending: false })
      .limit(1),
    admin
      .from("github_repositories")
      .select(repositorySelect)
      .eq("workspace_id", workspaceId)
      .order("full_name", { ascending: true }),
    admin
      .from("repository_onboarding_status")
      .select(onboardingSelect)
      .eq("workspace_id", workspaceId),
    admin
      .from("workspace_repository_profiles")
      .select(profileSelect)
      .eq("workspace_id", workspaceId),
  ]);

  const firstError = installationError ?? repositoryError ?? onboardingError ?? profileError;
  if (firstError) throw firstError;

  const onboardingByRepositoryId = new Map(
    ((onboardingRows ?? []) as OnboardingRow[]).map((row) => [row.github_repository_id, row]),
  );
  const profilesByRepositoryId = new Map(
    (profileRows ?? []).map((row) => [row.github_repository_id, mapRepositoryProfileRow(row)]),
  );
  const primaryProfileRow = (profileRows ?? []).find((row) => row.is_primary);
  const repositories = (repositoryRows ?? []).map((row) => {
    const repository = mapRepository(row);
    return {
      ...repository,
      onboarding: mapRepositoryOnboardingState(
        onboardingByRepositoryId.get(repository.id),
        repository.id,
      ),
      profile: profilesByRepositoryId.get(repository.id) ?? null,
    };
  });

  return {
    installation: installationRows?.[0] ? mapInstallation(installationRows[0]) : null,
    ...getGitHubConfigStatus(),
    primaryProfile: primaryProfileRow ? mapRepositoryProfileRow(primaryProfileRow) : null,
    repositories,
  };
}
