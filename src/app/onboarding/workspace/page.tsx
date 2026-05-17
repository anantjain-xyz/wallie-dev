import { redirect } from "next/navigation";

import { WorkspaceOnboardingForm } from "@/components/onboarding/workspace-onboarding-form";
import { PageHeader } from "@/components/ui/page-shell";
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
    <main id="main-content" className="min-h-screen bg-surface text-foreground">
      <div className="mx-auto w-full max-w-[640px] px-6 pb-24 pt-10 sm:px-8">
        <PageHeader title="Create workspace" description="Name your workspace to finish setup." />
        <WorkspaceOnboardingForm />
      </div>
    </main>
  );
}
