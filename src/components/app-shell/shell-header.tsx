"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { AccountMenu } from "@/components/app-shell/account-menu";
import { ThemeToggle } from "@/components/app-shell/theme-toggle";
import { PlusIcon } from "@/components/shared/icons";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  shouldShowOnboardingResumeCta,
  type OnboardingResumeState,
} from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import { type WorkspaceNavItem, workspaceBasePath, workspaceOnboardingPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type ShellHeaderProps = {
  defaultSessionGithubRepositoryId: string | null;
  navItems: WorkspaceNavItem[];
  onboarding: OnboardingResumeState | null;
  viewerEmail: string | null;
  workspace: WorkspaceSummary;
  workspaceAvatarUrl: string | null;
};

const loadCreateSessionDialog = () =>
  import("@/features/sessions/create-session-dialog").then((module) => module.CreateSessionDialog);

export function preloadCreateSessionDialogOnce(
  started: { current: boolean },
  load: () => Promise<unknown> = loadCreateSessionDialog,
) {
  if (started.current) {
    return;
  }

  started.current = true;
  // Reset on failure so a transient chunk error allows retry, not a permanent preload lockout.
  load().catch(() => {
    started.current = false;
  });
}

const CreateSessionLoadingCloseContext = createContext<(() => void) | null>(null);

export function CreateSessionDialogLoading({ onClose }: { onClose?: () => void } = {}) {
  const closeFromShell = useContext(CreateSessionLoadingCloseContext);

  return (
    <Dialog
      defaultOpen
      onOpenChange={(open) => {
        if (!open) (onClose ?? closeFromShell)?.();
      }}
    >
      <DialogContent description="The session form is loading." title="Start a new session">
        <div aria-busy="true" aria-live="polite" role="status">
          <div className="h-40 animate-pulse rounded bg-surface-muted" />
          <p className="mt-4 text-sm text-muted">Loading session form…</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const CreateSessionDialog = dynamic(loadCreateSessionDialog, {
  loading: () => <CreateSessionDialogLoading />,
  ssr: false,
});

function WorkspaceAvatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    return (
      <Image
        alt=""
        aria-hidden="true"
        className="h-5 w-5 shrink-0 rounded-[5px] border border-border object-cover"
        height={20}
        src={url}
        width={20}
      />
    );
  }

  const initial = name.trim().charAt(0).toUpperCase() || "W";

  return (
    <span
      aria-hidden="true"
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border border-border bg-surface-strong type-annotation font-semibold text-foreground"
    >
      {initial}
    </span>
  );
}

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
  viewerEmail,
  workspace,
  workspaceAvatarUrl,
}: ShellHeaderProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const shouldResumeSetup = shouldShowOnboardingResumeCta(onboarding);
  const onboardingHref = workspaceOnboardingPath(workspace.slug);

  // `?create=1` is a deep-link entrypoint (legacy redirect targets, bookmarks)
  // that auto-opens the dialog regardless of which page in the workspace the
  // user lands on.
  const createFromUrl = searchParams?.get("create") === "1";
  const [userCreateOpen, setUserCreateOpen] = useState(false);
  const createOpen = !shouldResumeSetup && (userCreateOpen || createFromUrl);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const createDialogPreloadStarted = useRef(false);

  useEffect(() => {
    if (shouldResumeSetup && createFromUrl) {
      router.replace(onboardingHref);
    }
  }, [createFromUrl, onboardingHref, router, shouldResumeSetup]);

  const handleCreateClose = useCallback(() => {
    setUserCreateOpen(false);
    if (createFromUrl) {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.delete("create");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : (pathname ?? "/"));
    }

    requestAnimationFrame(() => createButtonRef.current?.focus());
  }, [createFromUrl, pathname, router, searchParams]);

  function preloadCreateDialog() {
    preloadCreateSessionDialogOnce(createDialogPreloadStarted);
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
          <div className="flex min-w-0 shrink items-center gap-2">
            <Link
              href={pipelineHref}
              className="shrink-0 text-[15px] font-semibold tracking-tight text-foreground hover:opacity-80"
            >
              Wallie
            </Link>
            <span aria-hidden="true" className="shrink-0 text-muted">
              /
            </span>
            <Link
              href={pipelineHref}
              className="flex min-w-0 items-center gap-1.5 hover:opacity-80"
              title={workspace.name}
            >
              <WorkspaceAvatar name={workspace.name} url={workspaceAvatarUrl} />
              <span className="min-w-0 truncate text-[15px] font-medium text-foreground">
                {workspace.name}
              </span>
            </Link>
          </div>
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
                ref={createButtonRef}
                type="button"
                className="ui-button-primary inline-flex h-9 w-9 items-center gap-2 px-0 sm:h-auto sm:w-auto sm:px-3"
                aria-label="New session"
                onClick={() => setUserCreateOpen(true)}
                onFocus={preloadCreateDialog}
                onPointerEnter={preloadCreateDialog}
              >
                <PlusIcon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">New session</span>
              </button>
            )}
            <ThemeToggle />
            <AccountMenu email={viewerEmail} />
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

      {createOpen ? (
        <CreateSessionLoadingCloseContext.Provider value={handleCreateClose}>
          <CreateSessionDialog
            defaultGithubRepositoryId={defaultSessionGithubRepositoryId}
            open
            onClose={handleCreateClose}
            workspaceId={workspace.id}
            workspaceSlug={workspace.slug}
          />
        </CreateSessionLoadingCloseContext.Provider>
      ) : null}
    </>
  );
}
