import { redirect } from "next/navigation";

import { WorkspaceOnboardingForm } from "@/components/onboarding/workspace-onboarding-form";
import { PlaceholderPanel } from "@/components/shared/placeholder-panel";
import { ensureProfileForUser, resolveAuthenticatedHomePath } from "@/lib/auth";
import { loginPath, onboardingWorkspacePath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function WorkspaceOnboardingPage() {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    redirect(loginPath(onboardingWorkspacePath()));
  }

  await ensureProfileForUser(supabase, user);

  const landingPath = await resolveAuthenticatedHomePath(supabase);

  if (landingPath !== onboardingWorkspacePath()) {
    redirect(landingPath);
  }

  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-screen w-full max-w-6xl items-center px-4 py-8 sm:px-6 lg:px-8"
    >
      <PlaceholderPanel
        eyebrow="Workspace Bootstrap"
        title="Create the First Workspace & Enter the App Shell"
        summary="Create the first workspace, provision the owner membership, and bootstrap the system `wallie` member before Wallie sends you to `/w/[workspaceSlug]/issues`."
        titleAs="h1"
        tone="ready"
      >
        <WorkspaceOnboardingForm />
      </PlaceholderPanel>
    </main>
  );
}
