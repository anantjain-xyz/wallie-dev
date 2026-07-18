import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionRepositoryOption } from "@/features/sessions/types";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseLike = Pick<SupabaseClient<Database>, "from">;

const REPOSITORY_PAGE_SIZE = 1000;

export type SessionRepositoryOptionsWithPrimary = {
  primaryGithubRepositoryId: string | null;
  repositoryOptions: SessionRepositoryOption[];
};

export async function loadSessionRepositoryOptionsWithPrimary(input: {
  supabase: SupabaseLike;
  workspaceId: string;
}): Promise<SessionRepositoryOptionsWithPrimary> {
  const repositories: SessionRepositoryOption[] = [];
  let primaryGithubRepositoryId: string | null = null;

  for (let from = 0; ; from += REPOSITORY_PAGE_SIZE) {
    const { data, error } = await input.supabase
      .from("github_repositories")
      .select("id, full_name, workspace_repository_profiles(is_primary)")
      .eq("workspace_id", input.workspaceId)
      .eq("is_archived", false)
      .order("full_name", { ascending: true })
      .range(from, from + REPOSITORY_PAGE_SIZE - 1);

    if (error) throw error;

    const rows = data ?? [];
    for (const row of rows) {
      repositories.push({
        fullName: row.full_name,
        id: row.id,
      });

      if (
        !primaryGithubRepositoryId &&
        row.workspace_repository_profiles.some((profile) => profile.is_primary)
      ) {
        primaryGithubRepositoryId = row.id;
      }
    }

    if (rows.length < REPOSITORY_PAGE_SIZE) {
      return {
        primaryGithubRepositoryId,
        repositoryOptions: repositories,
      };
    }
  }
}

export function resolveDefaultSessionRepositoryId(input: {
  primaryGithubRepositoryId: string | null;
  repositoryOptions: readonly SessionRepositoryOption[];
  selectedGithubRepositoryId: string | null;
}): string | null {
  const availableRepositoryIds = new Set(
    input.repositoryOptions.map((repository) => repository.id),
  );

  if (
    input.primaryGithubRepositoryId &&
    availableRepositoryIds.has(input.primaryGithubRepositoryId)
  ) {
    return input.primaryGithubRepositoryId;
  }

  if (
    input.selectedGithubRepositoryId &&
    availableRepositoryIds.has(input.selectedGithubRepositoryId)
  ) {
    return input.selectedGithubRepositoryId;
  }

  return input.repositoryOptions[0]?.id ?? null;
}
