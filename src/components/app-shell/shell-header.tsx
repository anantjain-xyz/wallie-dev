"use client";

import Link from "next/link";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { AccountMenu } from "@/components/app-shell/account-menu";
import { RouteEntrance } from "@/components/app-shell/navigation-motion";
import {
  readSessionLaunchActivation,
  resolveSessionReturnTo,
  sessionLaunchHref,
  shellFactoryScope,
  shellNavDestination,
  withoutSessionLaunch,
} from "@/components/app-shell/shell-navigation";
import { ThemeToggle } from "@/components/app-shell/theme-toggle";
import {
  NavigationMenuIcon,
  WorkspaceNavLinks,
  WorkspaceSidebar,
} from "@/components/app-shell/workspace-sidebar";
import {
  WorkspaceSwitcher,
  type WorkspaceSwitcherOption,
} from "@/components/app-shell/workspace-switcher";
import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import {
  FACTORY_QUERY_PARAM,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import {
  shouldShowOnboardingResumeCta,
  type OnboardingResumeState,
} from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import {
  type WorkspaceNavItem,
  workspaceBasePath,
  workspaceOnboardingPath,
  workspaceSessionsPath,
} from "@/lib/routes";
import {
  finishInteraction,
  interactionRouteTemplateForPath,
  isUnmodifiedPrimaryClick,
  startInteraction,
} from "@/lib/telemetry/interaction-rum";
import { cn } from "@/lib/utils";
import type { SessionCreationPreview } from "@/features/sessions/pending-session-creation";

export type CreationFactory = {
  id: string;
  name: string;
};

type ShellHeaderProps = {
  creationFactory: CreationFactory | null;
  factories?: readonly FactorySelectionOption[];
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
  workspaceOptions?: readonly WorkspaceSwitcherOption[];
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

export function CreateSessionDialogLoading({
  onClose,
  onCloseAutoFocus,
  onRetry,
}: { onClose?: () => void; onCloseAutoFocus?: () => void; onRetry?: () => void } = {}) {
  const retryRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    finishInteraction("open_create_dialog", "success");
  }, []);

  useEffect(() => {
    if (onRetry) retryRef.current?.focus();
  }, [onRetry]);

  return (
    <Dialog
      defaultOpen
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DialogContent onCloseAutoFocus={onCloseAutoFocus} title="Start a new session">
        {onRetry ? (
          <div className="space-y-4">
            <p className="text-sm text-foreground" role="alert">
              Couldn’t load the session form. Try again or close to return.
            </p>
            <button className="ui-button-primary" onClick={onRetry} ref={retryRef} type="button">
              Retry
            </button>
          </div>
        ) : (
          <div aria-busy="true" role="status">
            <div aria-hidden="true" className="h-40 animate-pulse rounded bg-control-muted" />
            <p className="mt-4 text-sm text-muted">Loading session form…</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type CreateSessionDialogProps = ComponentProps<CreateSessionDialogComponent>;

export function CreateSessionDialogRequest({
  load = retainCreateSessionDialogModule,
  onClose,
  onCloseAutoFocus,
}: Pick<CreateSessionDialogProps, "onClose" | "onCloseAutoFocus"> & {
  load?: () => Promise<unknown>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [failedAttempt, setFailedAttempt] = useState<number | null>(null);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    let current = true;
    void load().catch(() => {
      if (current) setFailedAttempt(attempt);
    });
    return () => {
      current = false;
    };
  }, [attempt, load]);

  return (
    <CreateSessionDialogLoading
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      onRetry={failedAttempt === attempt ? retry : undefined}
    />
  );
}

function CreateSessionDialog(props: CreateSessionDialogProps) {
  const DialogImpl = useSyncExternalStore(
    subscribeCreateSessionDialog,
    () => createSessionDialogModule,
    () => null,
  );

  // next/dynamic wraps this chunk in Suspense. React then keeps that fallback
  // on screen for FALLBACK_THROTTLE_MS (300ms) after the chunk has already
  // loaded. Render the dialog from the resolved module instead.
  if (!DialogImpl) {
    return props.open ? (
      <CreateSessionDialogRequest
        onClose={props.onClose}
        onCloseAutoFocus={props.onCloseAutoFocus}
      />
    ) : null;
  }

  // The value is the cached module export, not a component created in render.
  // eslint-disable-next-line react-hooks/static-components -- module is loaded once and reused
  return <DialogImpl {...props} />;
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

function subscribeToLocationHash(change: () => void) {
  const { navigation } = window as Window & { navigation?: EventTarget };
  navigation?.addEventListener("currententrychange", change);
  window.addEventListener("hashchange", change);
  window.addEventListener("popstate", change);
  return () => {
    navigation?.removeEventListener("currententrychange", change);
    window.removeEventListener("hashchange", change);
    window.removeEventListener("popstate", change);
  };
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
  creationFactory,
  factories = creationFactory ? [{ ...creationFactory, isDefault: true, status: "active" }] : [],
  children,
  navItems,
  onboarding,
  pathnameOverride,
  viewerAvatarUrl,
  viewerEmail,
  viewerId,
  workspace,
  workspaceAvatarUrl,
  workspaceOptions = [],
}: ShellHeaderProps) {
  const routedPathname = usePathname();
  const pathname = pathnameOverride ?? routedPathname ?? workspaceBasePath(workspace.slug);
  const searchParams = useSearchParams();
  const locationHash = useSyncExternalStore(
    subscribeToLocationHash,
    () => window.location.hash,
    () => "",
  );
  const router = useRouter();
  const shouldResumeSetup = shouldShowOnboardingResumeCta(onboarding);
  const onboardingHref = workspaceOnboardingPath(workspace.slug);
  const headerRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const wideContent = pathname.startsWith(`${workspaceSessionsPath(workspace.slug)}/`);
  const sidebarMediaQuery = wideContent ? "(min-width: 80rem)" : "(min-width: 64rem)";
  const search = searchParams?.toString() ?? "";
  const locationKey = search ? `${pathname}?${search}` : pathname;
  const pipelineHref = workspaceBasePath(workspace.slug);
  const sessionsHref = workspaceSessionsPath(workspace.slug);
  const activeNavItem = navItems.find((item) => isActiveNavItem(pathname, workspace.slug, item));
  const [drawerLocation, setDrawerLocation] = useState<string | null>(null);
  const drawerOpen = drawerLocation === locationKey;
  if (drawerLocation !== null && !drawerOpen) setDrawerLocation(null);

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
    return () => {
      observer.disconnect();
      root.style.removeProperty("--shell-scroll-padding");
    };
  }, []);

  useEffect(() => {
    const desktop = window.matchMedia(sidebarMediaQuery);
    const closeDrawer = () => {
      if (desktop.matches) setDrawerLocation(null);
    };
    desktop.addEventListener("change", closeDrawer);
    return () => desktop.removeEventListener("change", closeDrawer);
  }, [sidebarMediaQuery]);

  // `?create=1` is a deep-link entrypoint (legacy redirect targets, bookmarks)
  // that auto-opens the dialog regardless of which page in the workspace the
  // user lands on. Creation only targets the workspace default factory, so the
  // dialog stays closed outside that factory's explicit scope.
  const scope = shellFactoryScope({
    factories,
    item: activeNavItem,
    pathname,
    query: searchParams?.getAll(FACTORY_QUERY_PARAM) ?? [],
    slug: workspace.slug,
  });
  const isDirectCreationScope =
    creationFactory !== null &&
    (scope.kind === "none" ||
      (scope.kind === "factory" && scope.factory.id === creationFactory.id));
  const createFromUrl = searchParams?.get("create") === "1";
  const urlWorkflowActivation = createFromUrl
    ? readSessionLaunchActivation(searchParams)
    : undefined;
  const returnValues = searchParams?.getAll("returnTo");
  const returnTo =
    returnValues?.length === 1 ? resolveSessionReturnTo(returnValues[0], workspace.slug) : null;
  const [userCreateOpen, setUserCreateOpen] = useState(false);
  const [recoverableWorkflowLaunch, setRecoverableWorkflowLaunch] = useState<{
    location: string;
    activationId: string | null;
  } | null>(null);
  if (
    recoverableWorkflowLaunch &&
    !createFromUrl &&
    recoverableWorkflowLaunch.location !== locationKey
  ) {
    setRecoverableWorkflowLaunch(null);
  }
  const createScope = `${viewerId}:${workspace.id}`;
  const createUrlKey = JSON.stringify([createScope, pathname, urlWorkflowActivation]);
  const [dismissedCreateUrlKey, setDismissedCreateUrlKey] = useState<string | null>(null);
  if (!createFromUrl && dismissedCreateUrlKey) setDismissedCreateUrlKey(null);
  // Leaving the direct scope closes the dialog but keeps it mounted: drafts and
  // attachments live inside it. Reopening takes an explicit new action.
  if (!isDirectCreationScope && userCreateOpen) setUserCreateOpen(false);
  const createOpen =
    isDirectCreationScope &&
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
  const createTriggerRef = useRef<HTMLButtonElement | HTMLAnchorElement | null>(null);
  const pendingFocusHref = useRef<string | null>(null);
  const committedLocation = useRef(locationKey);
  const launchHistory = useRef<{ returnTo: string; origin: string; arrived: boolean } | null>(null);
  const previewReturn = useRef<{ location: string; href: string } | null>(null);
  const setCreateTrigger = useCallback((element: HTMLButtonElement | HTMLAnchorElement | null) => {
    createTriggerRef.current = element;
  }, []);
  const createDialogPreloadStartedKey = useRef<string | null>(null);
  const prefetchedNavKeysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (shouldResumeSetup && createFromUrl) {
      router.replace(onboardingHref);
    }
  }, [createFromUrl, onboardingHref, router, shouldResumeSetup]);

  const restoreCreateFocus = useCallback(() => {
    if (pendingFocusHref.current !== committedLocation.current) return;
    const target = createTriggerRef.current ?? mainRef.current;
    target?.focus({ preventScroll: true });
    if (target === document.activeElement) pendingFocusHref.current = null;
  }, []);

  const handleCreateCloseAutoFocus = useCallback(() => {
    requestAnimationFrame(restoreCreateFocus);
  }, [restoreCreateFocus]);

  useEffect(() => {
    committedLocation.current = locationKey;
    const launch = launchHistory.current;
    const atLaunch =
      launch &&
      createFromUrl &&
      isDirectCreationScope &&
      pathname === sessionsHref &&
      returnTo === launch.returnTo;
    if (atLaunch) launch.arrived = true;
    if (launch?.arrived && !atLaunch && previewReturn.current?.location !== locationKey) {
      launchHistory.current = null;
      if (launch.origin.split("#", 1)[0] === locationKey) pendingFocusHref.current = locationKey;
    }
    if (
      previewReturn.current &&
      previewReturn.current.location !== locationKey &&
      createFromUrl === false
    ) {
      previewReturn.current = null;
    }
    if (pendingFocusHref.current !== locationKey) return;
    const frame = requestAnimationFrame(restoreCreateFocus);
    return () => cancelAnimationFrame(frame);
  }, [
    createFromUrl,
    isDirectCreationScope,
    locationKey,
    pathname,
    restoreCreateFocus,
    returnTo,
    sessionsHref,
  ]);

  const handleCreateClose = useCallback(() => {
    setUserCreateOpen(false);
    const previewActive =
      creationPreviewRef.current?.scope === createScope &&
      creationPreviewRef.current.pathname === pathname;
    const cleanHref = withoutSessionLaunch(pathname, search);
    if (createFromUrl) {
      setDismissedCreateUrlKey(createUrlKey);
    }
    if (previewActive) {
      if (createFromUrl) {
        setRecoverableWorkflowLaunch(
          urlWorkflowActivation === undefined
            ? null
            : { location: cleanHref, activationId: urlWorkflowActivation },
        );
        previewReturn.current = returnTo ? { location: cleanHref, href: returnTo } : null;
        router.replace(cleanHref, { scroll: false });
      }
      return;
    }
    const destination =
      (createFromUrl
        ? returnTo
        : previewReturn.current?.location === locationKey
          ? previewReturn.current.href
          : null) ??
      (createFromUrl && pathname !== sessionsHref
        ? workspaceSessionsPath(workspace.slug, { factory: creationFactory?.id })
        : cleanHref + window.location.hash);
    const launch = launchHistory.current;
    setRecoverableWorkflowLaunch(null);
    previewReturn.current = null;
    launchHistory.current = null;
    pendingFocusHref.current = destination.split("#", 1)[0];
    if (!createFromUrl && pendingFocusHref.current === locationKey) return;
    if (launch?.arrived && launch.origin === destination) router.back();
    else router.replace(destination, { scroll: destination.split(/[?#]/u, 1)[0] !== pathname });
  }, [
    createFromUrl,
    createScope,
    createUrlKey,
    creationFactory?.id,
    locationKey,
    pathname,
    returnTo,
    router,
    search,
    sessionsHref,
    urlWorkflowActivation,
    workspace.slug,
  ]);

  function preloadCreateDialog() {
    preloadCreateSessionDialogOnce(createDialogPreloadStartedKey, {
      userId: viewerId,
      workspaceId: workspace.id,
    });
  }

  function handleNavClick(
    event: MouseEvent<HTMLAnchorElement>,
    item: WorkspaceNavItem,
    mobile: boolean,
  ) {
    if (!isUnmodifiedPrimaryClick(event)) return;
    visibleCreationPreview?.dismiss();
    if (mobile) setDrawerLocation(null);
    if (pathname === pipelineHref && item.id === "sessions") {
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

  function navLinkProps(item: WorkspaceNavItem, mobile = false) {
    const { href, scopeNote } = shellNavDestination(item, workspace.slug, factories, scope);
    const skipPrefetch = item.id === "inbox" || item.id === "analytics" || item.id === "overview";
    return {
      href,
      scopeNote,
      // From the pipeline, load the real page ahead of the click. The default
      // stops at loading.tsx, and prefetching every page from every page
      // competes with opening a session.
      prefetch: skipPrefetch
        ? false
        : item !== activeNavItem && pathname === pipelineHref
          ? true
          : undefined,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => handleNavClick(event, item, mobile),
      ...(skipPrefetch ? {} : navPrefetchHandlers(href)),
    };
  }
  const pipelineItem = navItems.find((item) => item.id === "pipeline");
  const scopedPipelineHref = pipelineItem
    ? shellNavDestination(pipelineItem, workspace.slug, factories, scope).href
    : pipelineHref;

  function renderPrimaryAction() {
    if (shouldResumeSetup) {
      return (
        <Link className="ui-button-primary min-h-9 px-2.5 text-[13px]" href={onboardingHref}>
          <span className="lg:hidden">Setup</span>
          <span className="hidden lg:inline">Resume setup</span>
        </Link>
      );
    }
    if (!creationFactory) return null;

    const createActionClassName =
      "ui-button-primary inline-flex size-9 items-center justify-center gap-2 whitespace-nowrap px-0 lg:min-h-9 lg:w-auto lg:px-3";

    if (!isDirectCreationScope) {
      const creationSwitchHref = sessionLaunchHref(
        workspace.slug,
        creationFactory.id,
        withoutSessionLaunch(pathname, search, locationHash),
      );
      return (
        <Link
          className="ui-button-primary inline-flex min-h-9 max-w-[min(44vw,18rem)] items-center gap-1.5 px-2 py-1 text-left text-[13px] leading-tight"
          href={creationSwitchHref}
          onNavigate={(event) => {
            const hash = window.location.hash;
            visibleCreationPreview?.dismiss();
            const origin = withoutSessionLaunch(pathname, search, hash);
            const href = sessionLaunchHref(workspace.slug, creationFactory.id, origin);
            launchHistory.current = {
              returnTo: origin,
              origin: locationKey + hash,
              arrived: false,
            };
            if (href !== creationSwitchHref) {
              event.preventDefault();
              router.push(href);
            }
          }}
          ref={setCreateTrigger}
          {...navPrefetchHandlers(creationSwitchHref)}
        >
          <PlusIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            New session in {creationFactory.name}
          </span>
        </Link>
      );
    }

    return (
      <button
        ref={setCreateTrigger}
        type="button"
        className={createActionClassName}
        aria-label="New session"
        onClick={() => {
          startInteraction("open_create_dialog", interactionRouteTemplateForPath(pathname));
          setRecoverableWorkflowLaunch(null);
          setUserCreateOpen(true);
        }}
        onFocus={preloadCreateDialog}
        onPointerEnter={preloadCreateDialog}
      >
        <PlusIcon className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">New session</span>
      </button>
    );
  }

  return (
    <>
      <div className="flex min-h-[100svh] min-w-0 flex-col bg-sheet">
        <header
          className="ui-shell-header sticky top-0 z-20 min-w-0 border-b border-border bg-sheet"
          data-shell-header=""
          ref={headerRef}
        >
          <div className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-0.5 pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] lg:gap-x-4 lg:pl-[max(1.25rem,env(safe-area-inset-left))] lg:pr-[max(1.25rem,env(safe-area-inset-right))]">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 lg:gap-x-4">
              <WorkspaceSwitcher
                active={workspace}
                avatarUrl={workspaceAvatarUrl}
                currentPipelineLink={{
                  href: scopedPipelineHref,
                  ...navPrefetchHandlers(scopedPipelineHref),
                  onClick: (event) => {
                    if (isUnmodifiedPrimaryClick(event)) visibleCreationPreview?.dismiss();
                  },
                }}
                options={workspaceOptions}
              />
              {activeNavItem ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "hidden min-w-0 truncate border-l border-border pl-4 text-[13px] font-medium text-muted",
                    wideContent ? "xl:inline" : "lg:inline",
                  )}
                >
                  {activeNavItem.label}
                </span>
              ) : null}
              <Dialog
                open={drawerOpen}
                onOpenChange={(open) => setDrawerLocation(open ? locationKey : null)}
              >
                <DialogTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Workspace navigation: ${activeNavItem?.label ?? "Pages"}`}
                    className={cn(
                      "ui-shell-nav-link ui-shell-nav-link-active min-h-11 max-w-full gap-1.5 whitespace-normal px-2 text-left",
                      wideContent ? "xl:hidden" : "lg:hidden",
                    )}
                  >
                    <NavigationMenuIcon />
                    <span className="min-w-0 truncate">{activeNavItem?.label ?? "Pages"}</span>
                  </button>
                </DialogTrigger>
                <DialogContent
                  bodyClassName="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-1"
                  closeLabel="Close navigation"
                  onCloseAutoFocus={(event) => {
                    if (!window.matchMedia(sidebarMediaQuery).matches) return;
                    event.preventDefault();
                    const activeLink =
                      sidebarRef.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]');
                    (activeLink ?? mainRef.current)?.focus();
                  }}
                  title="Workspace pages"
                  variant="navigation"
                >
                  <nav aria-label="Workspace navigation" className="flex flex-1 flex-col gap-4">
                    <WorkspaceNavLinks
                      activeItem={activeNavItem}
                      getLinkProps={(item) => navLinkProps(item, true)}
                      items={navItems}
                      mobile
                    />
                  </nav>
                </DialogContent>
              </Dialog>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1 lg:gap-2">
              {renderPrimaryAction()}
              <ThemeToggle />
              <AccountMenu avatarUrl={viewerAvatarUrl} email={viewerEmail} />
            </div>
          </div>
        </header>

        <div className="flex min-w-0 flex-1">
          <WorkspaceSidebar
            activeItem={activeNavItem}
            getLinkProps={navLinkProps}
            items={navItems}
            pathname={pathname}
            sidebarRef={sidebarRef}
            wideContent={wideContent}
          />
          <main
            id="main-content"
            tabIndex={-1}
            className="min-w-0 flex-1 outline-none pb-[env(safe-area-inset-bottom)]"
            ref={mainRef}
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

      {creationFactory && mountedCreateScope === createScope ? (
        <CreateSessionDialog
          key={createScope}
          creationFactoryId={creationFactory.id}
          creationFactoryName={creationFactory.name}
          open={createOpen}
          onClose={handleCreateClose}
          onCloseAutoFocus={handleCreateCloseAutoFocus}
          onPreviewChange={handleCreationPreview}
          onReopen={handleCreateReopen}
          userId={viewerId}
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          workflowLaunchActivationId={
            createFromUrl
              ? urlWorkflowActivation
              : recoverableWorkflowLaunch?.location === locationKey
                ? recoverableWorkflowLaunch.activationId
                : undefined
          }
        />
      ) : null}
    </>
  );
}
