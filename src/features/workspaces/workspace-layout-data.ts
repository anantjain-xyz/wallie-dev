import "server-only";

import { cache } from "react";
import { notFound, redirect } from "next/navigation";

import {
  ensureProfileForUser,
  getWorkspaceBySlugForUser,
  hasAnyWorkspaceForUser,
  workspaceLoginRedirectPath,
} from "@/lib/auth";
import { mapOnboardingResumeState } from "@/features/onboarding/flow";
import type { SessionRepositoryOption } from "@/features/sessions/types";
import { loginPath, onboardingWorkspacePath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

async function loadSessionRepositoryContext(input: {
  selectedRepositoryId: string | null;
  supabase: SupabaseServerClient;
  workspaceId: string;
}): Promise<{
  defaultSessionGithubRepositoryId: string | null;
  sessionRepositoryOptions: SessionRepositoryOption[];
}> {
  const [
    { data: primaryProfileRow, error: primaryProfileError },
    { data: repositoryRows, error: repositoriesError },
  ] = await Promise.all([
    input.supabase
      .from("workspace_repository_profiles")
      .select("github_repository_id")
      .eq("workspace_id", input.workspaceId)
      .eq("is_primary", true)
      .maybeSingle(),
    input.supabase
      .from("github_repositories")
      .select("id, full_name")
      .eq("workspace_id", input.workspaceId)
      .eq("is_archived", false)
      .order("full_name", { ascending: true }),
  ]);

  if (primaryProfileError) {
    throw primaryProfileError;
  }
  if (repositoriesError) {
    throw repositoriesError;
  }

  const sessionRepositoryOptions = (repositoryRows ?? []).map((row) => ({
    fullName: row.full_name,
    id: row.id,
  }));
  const availableRepositoryIds = new Set(
    sessionRepositoryOptions.map((repository) => repository.id),
  );
  const primaryRepositoryId = primaryProfileRow?.github_repository_id ?? null;

  return {
    defaultSessionGithubRepositoryId:
      primaryRepositoryId && availableRepositoryIds.has(primaryRepositoryId)
        ? primaryRepositoryId
        : input.selectedRepositoryId && availableRepositoryIds.has(input.selectedRepositoryId)
          ? input.selectedRepositoryId
          : (sessionRepositoryOptions[0]?.id ?? null),
    sessionRepositoryOptions,
  };
}

export const loadWorkspaceLayoutContext = cache(async (workspaceSlug: string) => {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    redirect(loginPath(workspaceLoginRedirectPath(workspaceSlug)));
  }

  await ensureProfileForUser(supabase, user);

  const workspace = await getWorkspaceBySlugForUser(supabase, workspaceSlug);

  if (!workspace) {
    if (!(await hasAnyWorkspaceForUser(supabase))) {
      redirect(onboardingWorkspacePath());
    }

    notFound();
  }

  const { data: onboardingRow, error: onboardingError } = await supabase
    .from("workspace_onboarding")
    .select("current_step, selected_github_repository_id, status")
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (onboardingError) throw onboardingError;

  const repositoryContext = await loadSessionRepositoryContext({
    selectedRepositoryId: onboardingRow?.selected_github_repository_id ?? null,
    supabase,
    workspaceId: workspace.id,
  });

  return {
    defaultSessionGithubRepositoryId: repositoryContext.defaultSessionGithubRepositoryId,
    onboarding: mapOnboardingResumeState(onboardingRow),
    sessionRepositoryOptions: repositoryContext.sessionRepositoryOptions,
    supabase,
    user,
    workspace,
  };
});
