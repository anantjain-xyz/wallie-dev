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
import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { Dialog, DialogContent } from "@/components/ui/dialog";
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
import type { SessionCreationPreview } from "@/features/sessions/pending-session-creation";

type ShellHeaderProps = {
  children?: ReactNode;
  navItems: WorkspaceNavItem[];
  onboarding: OnboardingResumeState | null;
  /** Fixture/test override so chrome can render active nav off real routes. */
  pathnameOverride?: string;
  viewerAvatarUrl: string | null;
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

const CreateSessionLoadingCloseContext = createContext<{
  onClose: () => void;
  open: boolean;
} | null>(null);

export function CreateSessionDialogLoading({ onClose }: { onClose?: () => void } = {}) {
  const closeFromShell = useContext(CreateSessionLoadingCloseContext);

  useEffect(() => {
    finishInteraction("open_create_dialog", "success");
  }, []);

  if (closeFromShell && !closeFromShell.open) return null;

  return (
    <Dialog
      defaultOpen
      onOpenChange={(open) => {
        if (!open) (onClose ?? closeFromShell?.onClose)?.();
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

export function ShellHeader({
  children,
  navItems,
  onboarding,
  pathnameOverride,
  viewerAvatarUrl,
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

  // `?create=1` is a deep-link entrypoint (legacy redirect targets, bookmarks)
  // that auto-opens the dialog regardless of which page in the workspace the
  // user lands on.
  const createFromUrl = searchParams?.get("create") === "1";
  const [userCreateOpen, setUserCreateOpen] = useState(false);
  const createScope = `${viewerId}:${workspace.id}`;
  const createUrlKey = `${createScope}:${pathname}`;
  const [dismissedCreateUrlKey, setDismissedCreateUrlKey] = useState<string | null>(null);
  if (!createFromUrl && dismissedCreateUrlKey) setDismissedCreateUrlKey(null);
  const createOpen =
    !shouldResumeSetup &&
    (userCreateOpen || (createFromUrl && dismissedCreateUrlKey !== createUrlKey));
  const [creationPreview, setCreationPreview] = useState<{
    scope: string;
    pathname: string;
    preview: SessionCreationPreview;
  } | null>(null);
  const creationPreviewRef = useRef(creationPreview);
  const visibleCreationPreview =
    creationPreview?.scope === createScope && creationPreview.pathname === pathname
      ? creationPreview.preview
      : null;
  if (creationPreview && creationPreview.pathname !== pathname) setCreationPreview(null);
  const handleCreationPreview = useCallback(
    (preview: SessionCreationPreview | null) => {
      const next = preview ? { scope: createScope, pathname, preview } : null;
      creationPreviewRef.current = next;
      setCreationPreview(next);
    },
    [createScope, pathname],
  );
  const handleCreateReopen = useCallback(() => setUserCreateOpen(true), []);
  const [mountedCreateScope, setMountedCreateScope] = useState<string | null>(null);
  if (createOpen && mountedCreateScope !== createScope) {
    setMountedCreateScope(createScope);
  }
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const mobileCreateButtonRef = useRef<HTMLButtonElement>(null);
  const createDialogPreloadStartedKey = useRef<string | null>(null);
  useEffect(() => {
    if (shouldResumeSetup && createFromUrl) {
      router.replace(onboardingHref);
    }
  }, [createFromUrl, onboardingHref, router, shouldResumeSetup]);

  const handleCreateClose = useCallback(() => {
    setUserCreateOpen(false);
    if (createFromUrl) {
      setDismissedCreateUrlKey(createUrlKey);
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.delete("create");
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    }

    requestAnimationFrame(() => {
      if (
        creationPreviewRef.current?.scope === createScope &&
        creationPreviewRef.current.pathname === pathname
      )
        return;
      for (const ref of [createButtonRef, mobileCreateButtonRef]) {
        const element = ref.current;
        if (element && element.getClientRects().length > 0) {
          element.focus();
          return;
        }
      }
    });
  }, [createFromUrl, createScope, createUrlKey, pathname, router, searchParams]);

  function preloadCreateDialog() {
    preloadCreateSessionDialogOnce(createDialogPreloadStartedKey, {
      userId: viewerId,
      workspaceId: workspace.id,
    });
  }

  const pipelineHref = workspaceBasePath(workspace.slug);

  function handleNavClick(event: MouseEvent<HTMLAnchorElement>, item: WorkspaceNavItem) {
    if (isUnmodifiedPrimaryClick(event)) visibleCreationPreview?.dismiss();
    if (
      isUnmodifiedPrimaryClick(event) &&
      pathname === pipelineHref &&
      item.href.endsWith("/sessions")
    ) {
      startInteraction("pipeline_to_sessions", "/w/[workspaceSlug]", "/w/[workspaceSlug]/sessions");
    }
  }

  function renderNavLinks() {
    return navItems.map((item) => {
      const active = isActiveNavItem(pathname, workspace.slug, item);

      return (
        <Link
          key={item.href}
          href={item.href}
          aria-current={active ? "page" : undefined}
          className={cn("ui-shell-nav-link", active && "ui-shell-nav-link-active")}
          onClick={(event) => {
            handleNavClick(event, item);
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
        <div className="flex min-w-0 flex-1 flex-col bg-sheet">
          <header
            className="ui-shell-header sticky top-0 z-20 min-w-0 border-b border-border bg-sheet"
            data-shell-header=""
          >
            {/* Mobile / tablet header: workspace and actions above the navigation tabs. */}
            <div className="flex h-14 min-w-0 items-center gap-2 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] lg:hidden">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-foreground">
                  {workspace.name}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {renderPrimaryAction(mobileCreateButtonRef, { compact: true })}
                <ThemeToggle />
                <AccountMenu avatarUrl={viewerAvatarUrl} email={viewerEmail} mobileHeader />
              </div>
            </div>

            <nav
              aria-label="Workspace navigation"
              className="flex items-center gap-1 overflow-x-auto px-3 pb-2 lg:hidden"
            >
              {renderNavLinks()}
            </nav>

            {/* Desktop header: workspace identity, primary navigation, and global actions. */}
            <div className="hidden h-12 min-w-0 items-center justify-between gap-3 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] lg:flex">
              <div className="flex min-w-0 items-center gap-6">
                <Tooltip content={workspace.name}>
                  <Link
                    href={pipelineHref}
                    onClick={(event) => {
                      if (isUnmodifiedPrimaryClick(event)) visibleCreationPreview?.dismiss();
                    }}
                    className="flex min-w-0 max-w-48 items-center gap-2 rounded-[6px] py-1 hover:opacity-80"
                  >
                    <WorkspaceAvatar name={workspace.name} url={workspaceAvatarUrl} />
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {workspace.name}
                    </span>
                  </Link>
                </Tooltip>
                <nav aria-label="Workspace navigation" className="flex shrink-0 items-center gap-1">
                  {renderNavLinks()}
                </nav>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {renderPrimaryAction(createButtonRef)}
                <ThemeToggle />
                <AccountMenu avatarUrl={viewerAvatarUrl} email={viewerEmail} />
              </div>
            </div>
          </header>

          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 outline-none pb-[env(safe-area-inset-bottom)]"
          >
            {visibleCreationPreview?.content}
            <div
              className={visibleCreationPreview ? "hidden" : "contents"}
              hidden={Boolean(visibleCreationPreview)}
            >
              {children}
            </div>
          </main>
        </div>
      </div>

      {mountedCreateScope === createScope ? (
        <CreateSessionLoadingCloseContext.Provider
          value={{ onClose: handleCreateClose, open: createOpen }}
        >
          <CreateSessionDialog
            key={createScope}
            open={createOpen}
            onClose={handleCreateClose}
            onPreviewChange={handleCreationPreview}
            onReopen={handleCreateReopen}
            userId={viewerId}
            workspaceId={workspace.id}
            workspaceSlug={workspace.slug}
          />
        </CreateSessionLoadingCloseContext.Provider>
      ) : null}
    </>
  );
}
