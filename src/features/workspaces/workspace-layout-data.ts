import "server-only";

import { cache } from "react";

import { mapOnboardingResumeState } from "@/features/onboarding/flow";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { loadOwnProfileDisplay } from "@/lib/auth";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";
import { getWorkspaceAvatarUrl } from "@/lib/storage/workspace-avatar";

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

    const [onboardingResult, viewerProfile] = await Promise.all([
      timing.segment(
        "workspace-onboarding",
        () =>
          supabase
            .from("workspace_onboarding")
            .select("current_step, status")
            .eq("workspace_id", workspace.id)
            .maybeSingle(),
        (result) => ({
          payloadBytes: approximatePayloadSizeBytes(result.data),
          rows: result.data ? 1 : 0,
        }),
      ),
      timing.segment(
        "viewer-profile",
        () => loadOwnProfileDisplay(supabase, user.id),
        (profile) => ({
          payloadBytes: approximatePayloadSizeBytes(profile),
          rows: profile.found ? 1 : 0,
        }),
      ),
    ]);
    const { data: onboardingRow, error: onboardingError } = onboardingResult;
    if (onboardingError) throw onboardingError;

    return {
      onboarding: mapOnboardingResumeState(onboardingRow),
      supabase,
      user,
      viewerAvatarUrl: viewerProfile.avatarUrl,
      workspace,
      workspaceAvatarUrl: getWorkspaceAvatarUrl(workspace.avatar_path),
    };
  });
});
