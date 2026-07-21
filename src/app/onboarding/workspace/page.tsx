import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountMenu } from "@/components/app-shell/account-menu";
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
    <div className="flex min-h-[100svh] flex-col bg-sheet text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-sheet pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 w-full max-w-[640px] items-center justify-between gap-3 pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))] sm:pl-[max(2rem,env(safe-area-inset-left))] sm:pr-[max(2rem,env(safe-area-inset-right))]">
          <Link
            href="/"
            aria-label="Wallie home"
            className="flex min-h-11 items-center rounded-[6px] px-1 text-[22px] font-bold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            Wallie
          </Link>
          <AccountMenu email={user.email ?? null} />
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-[640px] flex-1 px-6 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-10 sm:px-8"
      >
        <PageHeader
          eyebrow="Step 1 of 2"
          title="Create workspace"
          description="Name your workspace, then connect GitHub and your agent to finish setup."
        />
        <WorkspaceOnboardingForm />
      </main>
    </div>
  );
}
