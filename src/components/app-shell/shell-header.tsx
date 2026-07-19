"use client";

import Image from "next/image";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { AccountMenu } from "@/components/app-shell/account-menu";
import { ThemeToggle } from "@/components/app-shell/theme-toggle";
import { MenuIcon } from "@/components/shared/icons/menu-icon";
import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { Dialog, DialogContent, DialogSideContent } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import {
  shouldShowOnboardingResumeCta,
  type OnboardingResumeState,
} from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import { type WorkspaceNavItem, workspaceBasePath, workspaceOnboardingPath } from "@/lib/routes";
import {
  finishInteraction,
  interactionRouteTemplateForPath,
  isUnmodifiedPrimaryClick,
  startInteraction,
} from "@/lib/telemetry/interaction-rum";
import { cn } from "@/lib/utils";

type ShellHeaderProps = {
  children?: ReactNode;
  navItems: WorkspaceNavItem[];
  onboarding: OnboardingResumeState | null;
  /** Fixture/test override so chrome can render active nav off real routes. */
  pathnameOverride?: string;
  viewerEmail: string | null;
  viewerId: string;
  workspace: WorkspaceSummary;
  workspaceAvatarUrl: string | null;
};

type CreateSessionDialogModule = typeof import("@/features/sessions/create-session-dialog");

const loadCreateSessionDialogModule = () => import("@/features/sessions/create-session-dialog");

export function preloadCreateSessionDialogOnce(
  startedKey: { current: string | null },
  input: { userId: string; workspaceId: string },
  load: () => Promise<
    Pick<CreateSessionDialogModule, "preloadSessionRepositories">
  > = loadCreateSessionDialogModule,
) {
  const key = `${input.userId}:${input.workspaceId}`;
  if (startedKey.current === key) {
    return;
  }

  startedKey.current = key;
  // Reset on failure so a transient chunk error allows retry, not a permanent preload lockout.
  load()
    .then((module) => module.preloadSessionRepositories(input))
    .catch(() => {
      if (startedKey.current === key) startedKey.current = null;
    });
}

const CreateSessionLoadingCloseContext = createContext<(() => void) | null>(null);

export function CreateSessionDialogLoading({ onClose }: { onClose?: () => void } = {}) {
  const closeFromShell = useContext(CreateSessionLoadingCloseContext);

  useEffect(() => {
    finishInteraction("open_create_dialog", "success");
  }, []);

  return (
    <Dialog
      defaultOpen
      onOpenChange={(open) => {
        if (!open) (onClose ?? closeFromShell)?.();
      }}
    >
      <DialogContent description="The session form is loading." title="Start a new session">
        <div aria-busy="true" aria-live="polite" role="status">
          <div className="h-40 animate-pulse rounded bg-control-muted" />
          <p className="mt-4 text-sm text-muted">Loading session form…</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const CreateSessionDialog = dynamic(
  () => loadCreateSessionDialogModule().then((module) => module.CreateSessionDialog),
  {
    loading: () => <CreateSessionDialogLoading />,
    ssr: false,
  },
);

function WorkspaceAvatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    return (
      <Image
        alt=""
        aria-hidden="true"
        className="h-6 w-6 shrink-0 rounded-[5px] border border-border object-cover"
        height={24}
        src={url}
        width={24}
      />
    );
  }

  const initial = name.trim().charAt(0).toUpperCase() || "W";

  return (
    <span
      aria-hidden="true"
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] border border-border bg-control-hover type-annotation font-semibold text-foreground"
    >
      {initial}
    </span>
  );
}

export function isActiveNavItem(pathname: string, workspaceSlug: string, item: WorkspaceNavItem) {
  const pipelineHref = workspaceBasePath(workspaceSlug);

  if (item.href === pipelineHref) {
    return pathname === pipelineHref;
  }

  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function resolveShellPageTitle(
  pathname: string,
  workspaceSlug: string,
  navItems: readonly WorkspaceNavItem[],
) {
  const active = navItems.find((item) => isActiveNavItem(pathname, workspaceSlug, item));
  if (active) {
    return active.label;
  }

  if (pathname.includes("/onboarding")) {
    return "Setup";
  }

  return "Workspace";
}

export function ShellHeader({
  children,
  navItems,
  onboarding,
  pathnameOverride,
  viewerEmail,
  viewerId,
  workspace,
  workspaceAvatarUrl,
}: ShellHeaderProps) {
  const routedPathname = usePathname();
  const pathname = pathnameOverride ?? routedPathname ?? workspaceBasePath(workspace.slug);
  const searchParams = useSearchParams();
  const router = useRouter();
  const shouldResumeSetup = shouldShowOnboardingResumeCta(onboarding);
  const onboardingHref = workspaceOnboardingPath(workspace.slug);
  const pageTitle = resolveShellPageTitle(pathname, workspace.slug, navItems);

  // `?create=1` is a deep-link entrypoint (legacy redirect targets, bookmarks)
  // that auto-opens the dialog regardless of which page in the workspace the
  // user lands on.
  const createFromUrl = searchParams?.get("create") === "1";
  const [userCreateOpen, setUserCreateOpen] = useState(false);
  const createOpen = !shouldResumeSetup && (userCreateOpen || createFromUrl);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCreateButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const createDialogPreloadStartedKey = useRef<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [navPathname, setNavPathname] = useState(pathname);
  const focusMainAfterNavCloseRef = useRef(false);

  if (pathname !== navPathname) {
    setNavPathname(pathname);
    if (navOpen) {
      setNavOpen(false);
    }
  }

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
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }

    requestAnimationFrame(() => {
      for (const ref of [createButtonRef, mobileCreateButtonRef, menuButtonRef]) {
        const element = ref.current;
        if (element && element.getClientRects().length > 0) {
          element.focus();
          return;
        }
      }
    });
  }, [createFromUrl, pathname, router, searchParams]);

  function preloadCreateDialog() {
    preloadCreateSessionDialogOnce(createDialogPreloadStartedKey, {
      userId: viewerId,
      workspaceId: workspace.id,
    });
  }

  const pipelineHref = workspaceBasePath(workspace.slug);

  function handleNavClick(
    event: MouseEvent<HTMLAnchorElement>,
    item: WorkspaceNavItem,
    options?: { fromSheet?: boolean },
  ) {
    if (
      isUnmodifiedPrimaryClick(event) &&
      pathname === pipelineHref &&
      item.href.endsWith("/sessions")
    ) {
      startInteraction("pipeline_to_sessions", "/w/[workspaceSlug]", "/w/[workspaceSlug]/sessions");
    }

    if (options?.fromSheet) {
      focusMainAfterNavCloseRef.current = true;
      setNavOpen(false);
    }
  }

  function renderNavLinks(options?: { fromSheet?: boolean; onNavigate?: () => void }) {
    return navItems.map((item) => {
      const active = isActiveNavItem(pathname, workspace.slug, item);

      return (
        <Link
          key={item.href}
          href={item.href}
          aria-current={active ? "page" : undefined}
          className={cn("ui-shell-nav-link", active && "ui-shell-nav-link-active")}
          onClick={(event) => {
            handleNavClick(event, item, { fromSheet: options?.fromSheet });
            options?.onNavigate?.();
          }}
        >
          {item.label}
        </Link>
      );
    });
  }

  function renderPrimaryAction(
    buttonRef: RefObject<HTMLButtonElement | null>,
    options?: { compact?: boolean },
  ) {
    if (shouldResumeSetup) {
      return (
        <Link
          className={cn("ui-button-primary min-h-9", options?.compact && "px-2.5 text-[13px]")}
          href={onboardingHref}
        >
          {options?.compact ? "Setup" : "Resume setup"}
        </Link>
      );
    }

    return (
      <button
        ref={buttonRef}
        type="button"
        className={cn(
          "ui-button-primary inline-flex items-center gap-2",
          options?.compact ? "size-9 justify-center px-0" : "min-h-9 px-3",
        )}
        aria-label="New session"
        onClick={() => {
          startInteraction("open_create_dialog", interactionRouteTemplateForPath(pathname));
          setUserCreateOpen(true);
        }}
        onFocus={preloadCreateDialog}
        onPointerEnter={preloadCreateDialog}
      >
        <PlusIcon className="h-3.5 w-3.5" />
        {options?.compact ? null : <span>New session</span>}
      </button>
    );
  }

  return (
    <>
      <div className="flex min-h-[100svh] min-w-0">
        <aside
          className="ui-shell-rail sticky top-0 z-20 hidden h-svh w-[208px] shrink-0 flex-col border-r border-border bg-sheet lg:flex"
          data-shell-rail=""
        >
          <div className="flex min-h-0 flex-1 flex-col gap-6 px-3 py-4">
            <div className="min-w-0 space-y-1 px-1">
              <Link
                href={pipelineHref}
                className="block text-[13px] font-semibold tracking-tight text-foreground hover:opacity-80"
              >
                Wallie
              </Link>
              <Tooltip content={workspace.name}>
                <Link
                  href={pipelineHref}
                  className="flex min-w-0 items-center gap-2 rounded-[6px] py-1 hover:opacity-80"
                >
                  <WorkspaceAvatar name={workspace.name} url={workspaceAvatarUrl} />
                  <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                    {workspace.name}
                  </span>
                </Link>
              </Tooltip>
            </div>

            <nav aria-label="Workspace navigation" className="min-w-0">
              <div className="flex flex-col gap-1">{renderNavLinks()}</div>
            </nav>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col bg-sheet">
          <header
            className="ui-shell-header sticky top-0 z-20 min-w-0 border-b border-border bg-sheet"
            data-shell-header=""
          >
            {/* Mobile / tablet header (<1024px): 56px row + menu sheet entry. */}
            <div className="flex h-14 min-w-0 items-center gap-2 px-3 lg:hidden">
              <button
                ref={menuButtonRef}
                type="button"
                className="ui-icon-button"
                aria-expanded={navOpen}
                aria-controls="workspace-nav-sheet"
                aria-label="Open workspace navigation"
                onClick={() => setNavOpen(true)}
              >
                <MenuIcon className="h-4 w-4" />
              </button>

              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-foreground">{pageTitle}</p>
                <p className="truncate type-annotation text-muted">{workspace.name}</p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {renderPrimaryAction(mobileCreateButtonRef, { compact: true })}
                <ThemeToggle />
                <AccountMenu email={viewerEmail} />
              </div>
            </div>

            {/* Desktop command header (≥1024px): 48px page identity + global actions. */}
            <div className="hidden h-12 min-w-0 items-center justify-between gap-3 px-5 lg:flex">
              <p className="min-w-0 truncate text-[15px] font-semibold text-foreground">
                {pageTitle}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                {renderPrimaryAction(createButtonRef)}
                <ThemeToggle />
                <AccountMenu email={viewerEmail} />
              </div>
            </div>
          </header>

          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 outline-none pb-[env(safe-area-inset-bottom)]"
          >
            {children}
          </main>
        </div>
      </div>

      <Dialog open={navOpen} onOpenChange={setNavOpen}>
        <DialogSideContent
          id="workspace-nav-sheet"
          title="Workspace"
          description={workspace.name}
          onCloseAutoFocus={(event) => {
            if (focusMainAfterNavCloseRef.current) {
              event.preventDefault();
              focusMainAfterNavCloseRef.current = false;
              document.getElementById("main-content")?.focus();
              return;
            }

            // Ensure restore lands on the visible menu trigger after Escape/dismiss.
            event.preventDefault();
            menuButtonRef.current?.focus();
          }}
        >
          <div className="mb-4 flex min-w-0 items-center gap-2 px-1">
            <WorkspaceAvatar name={workspace.name} url={workspaceAvatarUrl} />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-foreground">Wallie</p>
              <p className="truncate text-[13px] text-muted">{workspace.name}</p>
            </div>
          </div>
          <nav aria-label="Workspace navigation">
            <div className="flex flex-col gap-1">{renderNavLinks({ fromSheet: true })}</div>
          </nav>
        </DialogSideContent>
      </Dialog>

      {createOpen ? (
        <CreateSessionLoadingCloseContext.Provider value={handleCreateClose}>
          <CreateSessionDialog
            open
            onClose={handleCreateClose}
            userId={viewerId}
            workspaceId={workspace.id}
            workspaceSlug={workspace.slug}
          />
        </CreateSessionLoadingCloseContext.Provider>
      ) : null}
    </>
  );
}
