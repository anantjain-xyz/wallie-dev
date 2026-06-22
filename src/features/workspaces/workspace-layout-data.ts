import "server-only";

import { cache } from "react";

import { mapOnboardingResumeState } from "@/features/onboarding/flow";
import { loadDefaultSessionRepositoryId } from "@/features/sessions/repository-options";
import { getWorkspaceAvatarUrl } from "@/lib/storage/workspace-avatar";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

export const loadWorkspaceLayoutContext = cache(async (workspaceSlug: string) => {
  return withServerTiming("workspace.layout", { workspaceSlug }, async (timing) => {
    const { supabase, user, workspace } = await timing.segment(
      "auth-workspace-context",
      () => loadAuthenticatedWorkspaceContext(workspaceSlug),
      (context) => ({
        payloadBytes: approximatePayloadSizeBytes({
          userId: context.user.id,
          workspace: context.workspace,
        }),
        rows: 1,
      }),
    );

    const { data: onboardingRow, error: onboardingError } = await timing.segment(
      "workspace-onboarding",
      () =>
        supabase
          .from("workspace_onboarding")
          .select("current_step, selected_github_repository_id, status")
          .eq("workspace_id", workspace.id)
          .maybeSingle(),
      (result) => ({
        payloadBytes: approximatePayloadSizeBytes(result.data),
        rows: result.data ? 1 : 0,
      }),
    );
    if (onboardingError) throw onboardingError;

    const defaultSessionGithubRepositoryId = await timing.segment(
      "default-session-repository",
      () =>
        loadDefaultSessionRepositoryId({
          selectedRepositoryId: onboardingRow?.selected_github_repository_id ?? null,
          supabase,
          workspaceId: workspace.id,
        }),
      (repositoryId) => ({
        rows: repositoryId ? 1 : 0,
      }),
    );

    return {
      defaultSessionGithubRepositoryId,
      onboarding: mapOnboardingResumeState(onboardingRow),
      supabase,
      user,
      workspace,
      workspaceAvatarUrl: getWorkspaceAvatarUrl(workspace.avatar_path),
    };
  });
});
