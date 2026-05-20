import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";

type SupabaseLike = Pick<SupabaseClient<Database>, "from">;

export type EffectiveSessionRepository = {
  defaultBranch: string | null;
  defaultProgrammingLanguage: string | null;
  fullName: string;
  githubInstallationId: string;
  htmlUrl: string;
  id: string;
  isArchived: boolean;
  isPrivate: boolean;
};

export type EffectiveSessionRepositorySource =
  | "session_pull_request"
  | "workspace_primary_profile"
  | "workspace_onboarding";

export type EffectiveSessionRepositoryResolution = {
  repository: EffectiveSessionRepository | null;
  repositoryId: string | null;
  source: EffectiveSessionRepositorySource | null;
};

const repositorySelect =
  "id, github_installation_id, full_name, html_url, private, default_programming_language, default_branch, is_archived";

function mapRepository(
  row: Pick<
    Tables<"github_repositories">,
    | "default_branch"
    | "default_programming_language"
    | "full_name"
    | "github_installation_id"
    | "html_url"
    | "id"
    | "is_archived"
    | "private"
  >,
): EffectiveSessionRepository {
  return {
    defaultBranch: row.default_branch,
    defaultProgrammingLanguage: row.default_programming_language,
    fullName: row.full_name,
    githubInstallationId: row.github_installation_id,
    htmlUrl: row.html_url,
    id: row.id,
    isArchived: row.is_archived,
    isPrivate: row.private,
  };
}

async function loadRepository(
  supabase: SupabaseLike,
  input: {
    repositoryId: string;
    workspaceId: string;
  },
) {
  const { data, error } = await supabase
    .from("github_repositories")
    .select(repositorySelect)
    .eq("id", input.repositoryId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapRepository(data) : null;
}

async function loadCandidateRepositoryIds(input: {
  sessionId: string;
  supabase: SupabaseLike;
  workspaceId: string;
}) {
  const [
    { data: prRow, error: prError },
    { data: profileRow, error: profileError },
    { data: onboardingRow, error: onboardingError },
  ] = await Promise.all([
    input.supabase
      .from("session_pull_requests")
      .select("github_repository_id")
      .eq("workspace_id", input.workspaceId)
      .eq("session_id", input.sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    input.supabase
      .from("workspace_repository_profiles")
      .select("github_repository_id")
      .eq("workspace_id", input.workspaceId)
      .eq("is_primary", true)
      .maybeSingle(),
    input.supabase
      .from("workspace_onboarding")
      .select("selected_github_repository_id")
      .eq("workspace_id", input.workspaceId)
      .maybeSingle(),
  ]);

  if (prError) throw prError;
  if (profileError) throw profileError;
  if (onboardingError) throw onboardingError;

  return [
    {
      repositoryId: prRow?.github_repository_id ?? null,
      source: "session_pull_request" as const,
    },
    {
      repositoryId: profileRow?.github_repository_id ?? null,
      source: "workspace_primary_profile" as const,
    },
    {
      repositoryId: onboardingRow?.selected_github_repository_id ?? null,
      source: "workspace_onboarding" as const,
    },
  ];
}

export async function resolveEffectiveSessionRepository(input: {
  sessionId: string;
  supabase: SupabaseLike;
  workspaceId: string;
}): Promise<EffectiveSessionRepositoryResolution> {
  const candidates = await loadCandidateRepositoryIds(input);

  for (const candidate of candidates) {
    if (!candidate.repositoryId) {
      continue;
    }

    const repository = await loadRepository(input.supabase, {
      repositoryId: candidate.repositoryId,
      workspaceId: input.workspaceId,
    });

    if (repository) {
      return {
        repository,
        repositoryId: repository.id,
        source: candidate.source,
      };
    }
  }

  return {
    repository: null,
    repositoryId: null,
    source: null,
  };
}
