"use client";

import Image from "next/image";
import Link from "next/link";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { AccountMenu } from "@/components/app-shell/account-menu";
import { ThemeToggle } from "@/components/app-shell/theme-toggle";
import { RouteEntrance, WorkspaceNavigation } from "@/components/app-shell/navigation-motion";
import { CheckIcon } from "@/components/shared/icons/check-icon";
import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
type CreateSessionDialogComponent = CreateSessionDialogModule["CreateSessionDialog"];
type PreloadedCreateSessionDialogModule = Pick<
  CreateSessionDialogModule,
  "preloadSessionRepositories"
> &
  Partial<Pick<CreateSessionDialogModule, "CreateSessionDialog">>;

const loadCreateSessionDialogModule = () => import("@/features/sessions/create-session-dialog");

let createSessionDialogModule: CreateSessionDialogComponent | null = null;
let createSessionDialogModulePromise: Promise<CreateSessionDialogComponent> | null = null;
const createSessionDialogListeners = new Set<() => void>();

function publishCreateSessionDialog(component: CreateSessionDialogComponent) {
  if (createSessionDialogModule === component) return;
  createSessionDialogModule = component;
  for (const listener of createSessionDialogListeners) listener();
}

function subscribeCreateSessionDialog(listener: () => void) {
  createSessionDialogListeners.add(listener);
  return () => {
    createSessionDialogListeners.delete(listener);
  };
}

function retainCreateSessionDialogModule() {
  if (createSessionDialogModule) return Promise.resolve(createSessionDialogModule);
  if (!createSessionDialogModulePromise) {
    createSessionDialogModulePromise = loadCreateSessionDialogModule()
      .then((module) => {
        publishCreateSessionDialog(module.CreateSessionDialog);
        return module.CreateSessionDialog;
      })
      .catch((error: unknown) => {
        createSessionDialogModulePromise = null;
        throw error;
      });
  }
  return createSessionDialogModulePromise;
}

export function preloadCreateSessionDialogOnce(
  startedKey: { current: string | null },
  input: { userId: string; workspaceId: string },
  load: () => Promise<PreloadedCreateSessionDialogModule> = loadCreateSessionDialogModule,
) {
  const key = `${input.userId}:${input.workspaceId}`;
  if (startedKey.current === key) {
    return;
  }

  startedKey.current = key;
  // Reset on failure so a transient chunk error allows retry, not a permanent preload lockout.
  load()
    .then((module) => {
      if (module.CreateSessionDialog) publishCreateSessionDialog(module.CreateSessionDialog);
      return module.preloadSessionRepositories(input);
    })
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

type CreateSessionDialogProps = ComponentProps<CreateSessionDialogComponent>;

function CreateSessionDialog(props: CreateSessionDialogProps) {
  const DialogImpl = useSyncExternalStore(
    subscribeCreateSessionDialog,
    () => createSessionDialogModule,
    () => null,
  );

  useEffect(() => {
    if (!props.open || DialogImpl) return;
    void retainCreateSessionDialogModule().catch(() => undefined);
  }, [DialogImpl, props.open]);

  // next/dynamic wraps this chunk in Suspense. React then keeps that fallback
  // on screen for FALLBACK_THROTTLE_MS (300ms) after the chunk has already
  // loaded. Render the dialog from the resolved module instead.
  if (!DialogImpl) return <CreateSessionDialogLoading onClose={props.onClose} />;

  // The value is the cached module export, not a component created in render.
  // eslint-disable-next-line react-hooks/static-components -- module is loaded once and reused
  return <DialogImpl {...props} />;
}

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

function isShellNavIntentPointer(pointerType: string) {
  return pointerType === "" || pointerType === "mouse" || pointerType === "pen";
}

/** Prefetch a top-level workspace route once per `(currentPathname, targetHref)` pair on user intent. */
export function prefetchShellNavHrefOnIntent(
  router: { prefetch?: (href: string, options?: { kind: PrefetchKind }) => void },
  prefetchedKeys: Set<string>,
  currentPathname: string,
  targetHref: string,
): boolean {
  if (currentPathname === targetHref) {
    return false;
  }

  const key = `${currentPathname}->${targetHref}`;
  if (prefetchedKeys.has(key)) {
    return false;
  }

  prefetchedKeys.add(key);
  router.prefetch?.(targetHref, { kind: PrefetchKind.FULL });
  return true;
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
  const headerRef = useRef<HTMLElement>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const root = document.documentElement;
    const measure = () => {
      root.style.setProperty(
        "--shell-scroll-padding",
        `${header.getBoundingClientRect().height}px`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    const desktop = window.matchMedia("(min-width: 64rem)");
    const closeCompactMenu = () => {
      if (desktop.matches) setWorkspaceMenuOpen(false);
    };
    desktop.addEventListener("change", closeCompactMenu);
    return () => {
      observer.disconnect();
      desktop.removeEventListener("change", closeCompactMenu);
      root.style.removeProperty("--shell-scroll-padding");
    };
  }, []);

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
  const prefetchedNavKeysRef = useRef<Set<string> | null>(null);
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
  const activeNavItem = navItems.find((item) => isActiveNavItem(pathname, workspace.slug, item));

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

  function navPrefetchHandlers(targetHref: string) {
    const triggerPrefetch = () => {
      prefetchedNavKeysRef.current ??= new Set<string>();
      prefetchShellNavHrefOnIntent(router, prefetchedNavKeysRef.current, pathname, targetHref);
    };

    return {
      onFocus: triggerPrefetch,
      onPointerEnter: (event: PointerEvent<HTMLAnchorElement>) => {
        if (isShellNavIntentPointer(event.pointerType)) {
          triggerPrefetch();
        }
      },
    };
  }

  function renderNavLinks() {
    return navItems.map((item) => {
      const active = isActiveNavItem(pathname, workspace.slug, item);

      return (
        <Link
          key={item.href}
          href={item.href}
          // From the pipeline, load the real page ahead of the click. The default
          // stops at loading.tsx, and prefetching every page from every page
          // competes with opening a session.
          prefetch={!active && pathname === pipelineHref ? true : undefined}
          aria-current={active ? "page" : undefined}
          className={cn("ui-shell-nav-link", active && "ui-shell-nav-link-active")}
          onClick={(event) => {
            handleNavClick(event, item);
          }}
          {...navPrefetchHandlers(item.href)}
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
            ref={headerRef}
          >
            {/* Compact navigation can wrap above the actions when text is enlarged. */}
            <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-1.5 py-0.5 pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] lg:hidden">
              <p className="min-w-0 max-w-[28%] flex-1 truncate text-[13px] font-semibold text-foreground">
                {workspace.name}
              </p>
              <nav aria-label="Workspace navigation" className="max-w-full shrink-0">
                <DropdownMenu open={workspaceMenuOpen} onOpenChange={setWorkspaceMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Workspace navigation: ${activeNavItem?.label ?? "Pages"}`}
                      className="ui-shell-nav-link ui-shell-nav-link-active min-h-11 max-w-full gap-1.5 whitespace-normal px-2"
                    >
                      {activeNavItem?.label ?? "Pages"}
                      <ChevronDownIcon className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    label="Workspace pages"
                    className="w-48 min-w-0 max-w-[calc(100vw-1rem)]"
                    onCloseAutoFocus={(event) => {
                      if (!window.matchMedia("(min-width: 64rem)").matches) return;
                      event.preventDefault();
                      headerRef.current
                        ?.querySelector<HTMLAnchorElement>(
                          '.ui-shell-nav-link[aria-current="page"]',
                        )
                        ?.focus();
                    }}
                  >
                    {navItems.map((item) => {
                      const active = isActiveNavItem(pathname, workspace.slug, item);
                      return (
                        <DropdownMenuItem key={item.href} asChild className="min-h-11">
                          <Link
                            href={item.href}
                            prefetch={!active && pathname === pipelineHref ? true : undefined}
                            aria-current={active ? "page" : undefined}
                            onClick={(event) => handleNavClick(event, item)}
                            {...navPrefetchHandlers(item.href)}
                          >
                            {item.label}
                            {active ? <CheckIcon className="ml-auto h-3.5 w-3.5" /> : null}
                          </Link>
                        </DropdownMenuItem>
                      );
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </nav>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {renderPrimaryAction(mobileCreateButtonRef, { compact: true })}
                <ThemeToggle />
                <AccountMenu avatarUrl={viewerAvatarUrl} email={viewerEmail} mobileHeader />
              </div>
            </div>

            {/* Desktop header: workspace identity, primary navigation, and global actions. */}
            <div className="hidden h-12 min-w-0 items-center justify-between gap-3 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] lg:flex">
              <div className="flex min-w-0 items-center gap-6">
                <Tooltip content={workspace.name}>
                  <Link
                    href={pipelineHref}
                    onClick={(event) => {
                      if (isUnmodifiedPrimaryClick(event)) visibleCreationPreview?.dismiss();
                    }}
                    {...navPrefetchHandlers(pipelineHref)}
                    className="flex min-w-0 max-w-48 items-center gap-2 rounded-[6px] py-1 hover:opacity-80"
                  >
                    <WorkspaceAvatar name={workspace.name} url={workspaceAvatarUrl} />
                    <span className="truncate text-[13px] font-medium text-foreground">
                      {workspace.name}
                    </span>
                  </Link>
                </Tooltip>
                <WorkspaceNavigation
                  pathname={pathname}
                  className="flex shrink-0 items-center gap-1"
                >
                  {renderNavLinks()}
                </WorkspaceNavigation>
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
            <RouteEntrance pathname={pathname} />
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
