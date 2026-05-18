"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ThemeToggle } from "@/components/app-shell/theme-toggle";
import { LogoutIcon, PlusIcon } from "@/components/shared/icons";
import {
  shouldShowOnboardingResumeCta,
  type OnboardingResumeState,
} from "@/features/onboarding/flow";
import { CreateSessionDialog } from "@/features/sessions/create-session-dialog";
import type { WorkspaceSummary } from "@/lib/auth";
import { type WorkspaceNavItem, workspaceBasePath, workspaceOnboardingPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type ShellHeaderProps = {
  navItems: WorkspaceNavItem[];
  onboarding: OnboardingResumeState | null;
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
};

function isActive(pathname: string, workspaceSlug: string, item: WorkspaceNavItem) {
  const pipelineHref = workspaceBasePath(workspaceSlug);

  if (item.href === pipelineHref) {
    return pathname === pipelineHref;
  }

  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function ShellHeader({ navItems, onboarding, viewerEmail, workspace }: ShellHeaderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const signOutLabel = viewerEmail ? `Sign out ${viewerEmail}` : "Sign out";
  const shouldResumeSetup = shouldShowOnboardingResumeCta(onboarding);
  const onboardingHref = workspaceOnboardingPath(workspace.slug);

  // `?create=1` is a deep-link entrypoint (legacy redirect targets, bookmarks)
  // that auto-opens the dialog regardless of which page in the workspace the
  // user lands on.
  const createFromUrl = searchParams?.get("create") === "1";
  const [userCreateOpen, setUserCreateOpen] = useState(false);
  const createOpen = !shouldResumeSetup && (userCreateOpen || createFromUrl);

  useEffect(() => {
    if (shouldResumeSetup && createFromUrl) {
      router.replace(onboardingHref);
    }
  }, [createFromUrl, onboardingHref, router, shouldResumeSetup]);

  function handleCreateClose() {
    setUserCreateOpen(false);
    if (createFromUrl) {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.delete("create");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : (pathname ?? "/"));
    }
  }

  const pipelineHref = workspaceBasePath(workspace.slug);

  return (
    <header className="sticky top-0 z-20 flex h-14 min-w-0 items-center justify-between gap-3 border-b border-border bg-surface px-3 sm:px-5">
      <Link
        href={pipelineHref}
        className="shrink-0 text-[15px] font-semibold tracking-tight text-foreground hover:opacity-80"
      >
        Wallie
      </Link>
      <nav className="min-w-0 flex-1 overflow-x-auto" aria-label="Workspace navigation">
        <div className="flex min-w-max items-center gap-1">
          {navItems.map((item) => {
            const active = isActive(pathname, workspace.slug, item);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn("ui-top-nav-tab", active && "ui-top-nav-tab-active")}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="flex shrink-0 items-center gap-2">
        {shouldResumeSetup ? (
          <Link className="ui-button-primary" href={onboardingHref}>
            Resume setup
          </Link>
        ) : (
          <button
            type="button"
            className="ui-button-primary inline-flex items-center gap-2"
            onClick={() => setUserCreateOpen(true)}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New session
          </button>
        )}
        <ThemeToggle />
        <form action="/auth/signout" method="post">
          <button type="submit" className="ui-icon-button" aria-label={signOutLabel}>
            <LogoutIcon className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>

      <CreateSessionDialog
        open={createOpen}
        onClose={handleCreateClose}
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
      />
    </header>
  );
}
