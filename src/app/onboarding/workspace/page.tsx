import Image from "next/image";
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
    <div className="flex min-h-screen flex-col bg-sheet text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-sheet">
        <div className="mx-auto flex h-14 w-full max-w-[640px] items-center justify-between gap-3 px-6 sm:px-8">
          <Link
            href="/"
            aria-label="Wallie home"
            className="flex items-center gap-2.5 focus-visible:outline-none"
          >
            <Image
              src="/wallie-logo-minimal.png"
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 rounded-[6px] object-contain dark:invert"
              priority
            />
            <span className="text-[16px] font-semibold tracking-tight text-foreground">Wallie</span>
          </Link>
          <AccountMenu email={user.email ?? null} />
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-[640px] flex-1 px-6 pb-24 pt-10 sm:px-8"
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
