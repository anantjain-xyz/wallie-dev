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
import type { SessionRepositoryOption } from "@/features/sessions/types";
import type { WorkspaceSummary } from "@/lib/auth";
import { type WorkspaceNavItem, workspaceBasePath, workspaceOnboardingPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type ShellHeaderProps = {
  defaultSessionGithubRepositoryId: string | null;
  navItems: WorkspaceNavItem[];
  onboarding: OnboardingResumeState | null;
  sessionRepositoryOptions: SessionRepositoryOption[];
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

export function ShellHeader({
  defaultSessionGithubRepositoryId,
  navItems,
  onboarding,
  sessionRepositoryOptions,
  viewerEmail,
  workspace,
}: ShellHeaderProps) {
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
  function renderNavLinks(className?: string) {
    return navItems.map((item) => {
      const active = isActive(pathname, workspace.slug, item);

      return (
        <Link
          key={item.href}
          href={item.href}
          aria-current={active ? "page" : undefined}
          className={cn("ui-top-nav-tab", className, active && "ui-top-nav-tab-active")}
        >
          {item.label}
        </Link>
      );
    });
  }

  return (
    <>
      <header className="sticky top-0 z-20 min-w-0 border-b border-border bg-surface">
        <div className="flex h-14 min-w-0 items-center justify-between gap-3 px-3 sm:px-5">
          <Link
            href={pipelineHref}
            className="shrink-0 text-[15px] font-semibold tracking-tight text-foreground hover:opacity-80"
          >
            Wallie
          </Link>
          <nav className="hidden min-w-0 flex-1 sm:block" aria-label="Workspace navigation">
            <div className="flex min-w-0 items-center gap-1">{renderNavLinks()}</div>
          </nav>

          <div className="flex shrink-0 items-center gap-2">
            {shouldResumeSetup ? (
              <Link className="ui-button-primary min-h-9" href={onboardingHref}>
                Resume setup
              </Link>
            ) : (
              <button
                type="button"
                className="ui-button-primary inline-flex h-9 w-9 items-center gap-2 px-0 sm:h-auto sm:w-auto sm:px-3"
                aria-label="New session"
                onClick={() => setUserCreateOpen(true)}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">New session</span>
              </button>
            )}
            <ThemeToggle />
            <form action="/auth/signout" method="post">
              <button type="submit" className="ui-icon-button" aria-label={signOutLabel}>
                <LogoutIcon className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>
        </div>

        <nav
          className="border-t border-border px-2 py-2 sm:hidden"
          aria-label="Workspace navigation"
        >
          <div className="grid grid-cols-3 gap-1">
            {renderNavLinks("w-full justify-center px-2")}
          </div>
        </nav>
      </header>

      <CreateSessionDialog
        defaultGithubRepositoryId={defaultSessionGithubRepositoryId}
        open={createOpen}
        onClose={handleCreateClose}
        repositoryOptions={sessionRepositoryOptions}
        workspaceId={workspace.id}
        workspaceSlug={workspace.slug}
      />
    </>
  );
}
