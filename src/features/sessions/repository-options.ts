import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { SessionRepositoryOption } from "@/features/sessions/types";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseLike = Pick<SupabaseClient<Database>, "from">;

const REPOSITORY_PAGE_SIZE = 1000;

async function loadAvailableRepositoryId(input: {
  repositoryId: string;
  supabase: SupabaseLike;
  workspaceId: string;
}) {
  const { data, error } = await input.supabase
    .from("github_repositories")
    .select("id")
    .eq("id", input.repositoryId)
    .eq("workspace_id", input.workspaceId)
    .eq("is_archived", false)
    .maybeSingle();

  if (error) throw error;
  return data?.id ?? null;
}

async function loadFirstRepositoryId(input: { supabase: SupabaseLike; workspaceId: string }) {
  const { data, error } = await input.supabase
    .from("github_repositories")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("is_archived", false)
    .order("full_name", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.id ?? null;
}

export async function loadDefaultSessionRepositoryId(input: {
  selectedRepositoryId: string | null;
  supabase: SupabaseLike;
  workspaceId: string;
}): Promise<string | null> {
  const [{ data: primaryProfileRow, error: primaryProfileError }, firstRepositoryId] =
    await Promise.all([
      input.supabase
        .from("workspace_repository_profiles")
        .select("github_repository_id")
        .eq("workspace_id", input.workspaceId)
        .eq("is_primary", true)
        .maybeSingle(),
      loadFirstRepositoryId(input),
    ]);

  if (primaryProfileError) throw primaryProfileError;

  const primaryRepositoryId = primaryProfileRow?.github_repository_id ?? null;
  if (primaryRepositoryId) {
    const availablePrimaryId = await loadAvailableRepositoryId({
      repositoryId: primaryRepositoryId,
      supabase: input.supabase,
      workspaceId: input.workspaceId,
    });
    if (availablePrimaryId) return availablePrimaryId;
  }

  if (input.selectedRepositoryId) {
    const availableSelectedId = await loadAvailableRepositoryId({
      repositoryId: input.selectedRepositoryId,
      supabase: input.supabase,
      workspaceId: input.workspaceId,
    });
    if (availableSelectedId) return availableSelectedId;
  }

  return firstRepositoryId;
}

export async function loadSessionRepositoryOptions(input: {
  supabase: SupabaseLike;
  workspaceId: string;
}): Promise<SessionRepositoryOption[]> {
  const repositories: SessionRepositoryOption[] = [];

  for (let from = 0; ; from += REPOSITORY_PAGE_SIZE) {
    const { data, error } = await input.supabase
      .from("github_repositories")
      .select("id, full_name")
      .eq("workspace_id", input.workspaceId)
      .eq("is_archived", false)
      .order("full_name", { ascending: true })
      .range(from, from + REPOSITORY_PAGE_SIZE - 1);

    if (error) throw error;

    const rows = data ?? [];
    repositories.push(
      ...rows.map((row) => ({
        fullName: row.full_name,
        id: row.id,
      })),
    );

    if (rows.length < REPOSITORY_PAGE_SIZE) {
      return repositories;
    }
  }
}
