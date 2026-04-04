import "server-only";

import { randomUUID } from "node:crypto";

import { App } from "@octokit/app";

import { resolveGitHubAppConfig } from "@/features/github/config";
import type {
  GitHubInstallationSummary,
  GitHubRepositorySummary,
} from "@/features/github/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";

type GitHubRepository = {
  archived: boolean;
  default_branch: string | null;
  description: string | null;
  full_name: string;
  html_url: string;
  id: number;
  language: string | null;
  name: string;
  private: boolean;
};

const installationSelect =
  "id, app_id, installation_id, installation_url, permissions, suspended, target_name, target_type, updated_at, workspace_id";
const repositorySelect =
  "id, repo_id, name, full_name, private, html_url, description, default_programming_language, default_branch, is_archived";

let githubAppSingleton: App | null = null;

export function createGitHubApp(input: Record<string, string | undefined> = process.env) {
  if (githubAppSingleton && input === process.env) {
    return githubAppSingleton;
  }

  const config = resolveGitHubAppConfig(input);
  const app = new App(config);

  if (input === process.env) {
    githubAppSingleton = app;
  }

  return app;
}

export async function resolveGitHubInstallSlug(
  input: Record<string, string | undefined> = process.env,
) {
  const app = createGitHubApp(input);
  const { data } = await app.octokit.request("GET /app");

  if (!data) {
    throw new Error("GitHub App metadata request returned no data.");
  }

  return data.slug;
}

async function listInstallationRepositories(
  installationId: number,
  input: Record<string, string | undefined> = process.env,
) {
  const app = createGitHubApp(input);
  const octokit = await app.getInstallationOctokit(installationId);
  const repositories: GitHubRepository[] = [];
  let page = 1;

  while (true) {
    const response = await octokit.request("GET /installation/repositories", {
      page,
      per_page: 100,
    });
    const pageRepositories = response.data.repositories as GitHubRepository[];

    repositories.push(...pageRepositories);

    if (pageRepositories.length < 100) {
      break;
    }

    page += 1;
  }

  return repositories;
}

export async function fetchGitHubInstallationFromApp(
  installationId: number,
  input: Record<string, string | undefined> = process.env,
) {
  const app = createGitHubApp(input);
  const { data } = await app.octokit.request("GET /app/installations/{installation_id}", {
    installation_id: installationId,
  });

  return data;
}

function mapInstallationSummary(
  row: Pick<
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
  >,
): GitHubInstallationSummary {
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

function mapRepositorySummary(
  row: Pick<
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
  >,
): GitHubRepositorySummary {
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

type UpsertGitHubInstallationInput = {
  installationId: number;
  workspaceId: string;
};

function resolveGitHubInstallationTargetName(
  installation: Awaited<ReturnType<typeof fetchGitHubInstallationFromApp>>,
) {
  if (installation.account && "login" in installation.account) {
    return installation.account.login;
  }

  if (installation.account && "slug" in installation.account) {
    return installation.account.slug;
  }

  return "unknown";
}

export async function upsertGitHubInstallationForWorkspace(
  values: UpsertGitHubInstallationInput,
  input: Record<string, string | undefined> = process.env,
) {
  const admin = createSupabaseAdminClient(input);
  const installation = await fetchGitHubInstallationFromApp(values.installationId, input);
  const { data: existingRows, error: existingError } = await admin
    .from("github_installations")
    .select(installationSelect)
    .or(`workspace_id.eq.${values.workspaceId},installation_id.eq.${values.installationId}`);

  if (existingError) {
    throw existingError;
  }

  const workspaceRow = (existingRows ?? []).find((row) => row.workspace_id === values.workspaceId);
  const installationRow = (existingRows ?? []).find(
    (row) => row.installation_id === values.installationId,
  );
  const recordId = workspaceRow?.id ?? installationRow?.id ?? randomUUID();

  if (installationRow && installationRow.id !== recordId) {
    const { error: deleteDuplicateError } = await admin
      .from("github_installations")
      .delete()
      .eq("id", installationRow.id);

    if (deleteDuplicateError) {
      throw deleteDuplicateError;
    }
  }

  let data:
    | (Pick<
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
        | "workspace_id"
      > & {
        workspace_id: string;
      })
    | null = null;
  let error: { message: string } | null = null;

  if (workspaceRow || installationRow) {
    const updateResult = await admin
      .from("github_installations")
      .update({
        app_id: installation.app_id,
        installation_id: installation.id,
        installation_url: installation.html_url,
        permissions: installation.permissions,
        suspended: false,
        target_name: resolveGitHubInstallationTargetName(installation),
        target_type: installation.target_type,
        workspace_id: values.workspaceId,
      })
      .eq("id", recordId)
      .select(installationSelect)
      .single();

    data = updateResult.data;
    error = updateResult.error;
  } else {
    const insertResult = await admin
      .from("github_installations")
      .insert({
        app_id: installation.app_id,
        id: recordId,
        installation_id: installation.id,
        installation_url: installation.html_url,
        permissions: installation.permissions,
        suspended: false,
        target_name: resolveGitHubInstallationTargetName(installation),
        target_type: installation.target_type,
        workspace_id: values.workspaceId,
      })
      .select(installationSelect)
      .single();

    data = insertResult.data;
    error = insertResult.error;
  }

  if (error) {
    throw error;
  }

  return mapInstallationSummary(data!);
}

export async function syncGitHubRepositoriesForWorkspace(
  values: {
    installationId: number;
    workspaceId: string;
  },
  input: Record<string, string | undefined> = process.env,
) {
  const admin = createSupabaseAdminClient(input);
  const repositories = await listInstallationRepositories(values.installationId, input);
  const { data: installationRow, error: installationError } = await admin
    .from("github_installations")
    .select(installationSelect)
    .eq("workspace_id", values.workspaceId)
    .eq("installation_id", values.installationId)
    .single();

  if (installationError) {
    throw installationError;
  }

  const { data: existingRepos, error: existingReposError } = await admin
    .from("github_repositories")
    .select(repositorySelect)
    .eq("github_installation_id", installationRow.id);

  if (existingReposError) {
    throw existingReposError;
  }

  const existingRepoIdByGitHubRepoId = new Map(
    (existingRepos ?? []).map((repo) => [repo.repo_id, repo.id]),
  );
  const currentRepoIds = new Set(repositories.map((repo) => repo.id));

  if (repositories.length > 0) {
    const { error: upsertError } = await admin.from("github_repositories").upsert(
      repositories.map((repo) => ({
        default_branch: repo.default_branch ?? null,
        default_programming_language: repo.language ?? null,
        description: repo.description ?? null,
        full_name: repo.full_name,
        github_installation_id: installationRow.id,
        html_url: repo.html_url,
        id: existingRepoIdByGitHubRepoId.get(repo.id) ?? randomUUID(),
        is_archived: repo.archived,
        name: repo.name,
        private: repo.private,
        repo_id: repo.id,
        workspace_id: values.workspaceId,
      })),
      {
        onConflict: "github_installation_id,repo_id",
      },
    );

    if (upsertError) {
      throw upsertError;
    }
  }

  const removedRepoIds = (existingRepos ?? [])
    .map((repo) => repo.repo_id)
    .filter((repoId) => !currentRepoIds.has(repoId));

  if (removedRepoIds.length > 0) {
    const { error: deleteError } = await admin
      .from("github_repositories")
      .delete()
      .eq("github_installation_id", installationRow.id)
      .in("repo_id", removedRepoIds);

    if (deleteError) {
      throw deleteError;
    }
  }

  const { data: syncedRepos, error: syncedReposError } = await admin
    .from("github_repositories")
    .select(repositorySelect)
    .eq("github_installation_id", installationRow.id)
    .order("full_name", { ascending: true });

  if (syncedReposError) {
    throw syncedReposError;
  }

  return {
    installation: mapInstallationSummary(installationRow),
    repositories: (syncedRepos ?? []).map(mapRepositorySummary),
  };
}

export async function syncGitHubInstallationAndRepositories(
  values: UpsertGitHubInstallationInput,
  input: Record<string, string | undefined> = process.env,
) {
  const installation = await upsertGitHubInstallationForWorkspace(values, input);
  const syncResult = await syncGitHubRepositoriesForWorkspace(
    {
      installationId: installation.installationId,
      workspaceId: values.workspaceId,
    },
    input,
  );

  return {
    installation,
    repositories: syncResult.repositories,
  };
}
