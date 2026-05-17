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
import { loginPath, onboardingWorkspacePath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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
    .select("current_step, status")
    .eq("workspace_id", workspace.id)
    .maybeSingle();
  if (onboardingError) throw onboardingError;

  return {
    onboarding: mapOnboardingResumeState(onboardingRow),
    supabase,
    user,
    workspace,
  };
});
