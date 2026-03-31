import { redirect } from "next/navigation";

import { WorkspaceOnboardingForm } from "@/components/onboarding/workspace-onboarding-form";
import { PlaceholderPanel } from "@/components/shared/placeholder-panel";
import {
  ensureProfileForUser,
  resolveAuthenticatedHomePath,
} from "@/lib/auth";
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
    <main className="mx-auto flex min-h-screen w-full max-w-6xl items-center px-4 py-8 sm:px-6 lg:px-8">
      <PlaceholderPanel
        eyebrow="Workspace Bootstrap"
        title="Create the first workspace and enter the app shell"
        summary="This flow provisions the workspace, owner membership, and system `wallie` member through a server-backed contract before routing into `/w/[workspaceSlug]/issues`."
        tone="ready"
      >
        <WorkspaceOnboardingForm />
      </PlaceholderPanel>
    </main>
  );
}
