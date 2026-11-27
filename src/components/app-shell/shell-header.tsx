"use client";

import Link from "next/link";
import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { AccountMenu } from "@/components/app-shell/account-menu";
import {
  getGroupedWorkspaceNavigation,
  WorkspaceGroupTabs,
} from "@/components/app-shell/grouped-workspace-navigation";
import { RouteEntrance } from "@/components/app-shell/navigation-motion";
import {
  readSessionLaunchActivation,
  resolveSessionReturnTo,
  sessionLaunchHref,
  withoutSessionLaunch,
} from "@/components/app-shell/shell-navigation";
import { ThemeToggle } from "@/components/app-shell/theme-toggle";
import { WorkspaceFactoryPicker } from "@/components/app-shell/workspace-factory-picker";
import {
  matchWorkspaceLocation,
  readFactoryRequest,
  workspaceScopeHref,
  workspaceScopeLocationKey,
  workspaceScopeOptions,
} from "@/components/app-shell/workspace-location";
import {
  useRememberedWorkspaceScope,
  useWorkspaceScopeSnapshot,
  WorkspaceScopeContext,
} from "@/components/app-shell/workspace-scope-context";
import {
  NavigationMenuIcon,
  type ShellNavItem,
  WorkspaceNavLinks,
  WorkspaceSidebar,
} from "@/components/app-shell/workspace-sidebar";
import {
  WorkspaceSwitcher,
  type WorkspaceSwitcherOption,
} from "@/components/app-shell/workspace-switcher";
import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import {
  shouldShowOnboardingResumeCta,
  type OnboardingResumeState,
} from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import { workspaceBasePath, workspaceOnboardingPath, workspaceSessionsPath } from "@/lib/routes";
import {
  finishInteraction,
  interactionRouteTemplateForPath,
  isUnmodifiedPrimaryClick,
  startInteraction,
} from "@/lib/telemetry/interaction-rum";
import { cn } from "@/lib/utils";
import type { SessionCreationPreview } from "@/features/sessions/pending-session-creation";
import type { SessionCreationScope } from "@/features/sessions/create-session-dialog";

type ShellHeaderProps = {
  canManageFactoryDefinition?: boolean;
  factories?: readonly FactorySelectionOption[];
  children?: ReactNode;
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
  startedKeys: Set<string>,
  input: { userId: string; workspaceId: string; factoryId?: string },
  load: () => Promise<PreloadedCreateSessionDialogModule> = loadCreateSessionDialogModule,
) {
  const key = JSON.stringify([input.userId, input.workspaceId, input.factoryId ?? null]);
  if (startedKeys.has(key)) return;
  startedKeys.add(key);
  load()
    .then((module) => {
      if (module.CreateSessionDialog) publishCreateSessionDialog(module.CreateSessionDialog);
      if (input.factoryId) return module.preloadSessionRepositories(input);
    })
    .catch(() => {
      startedKeys.delete(key);
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
  canManageFactoryDefinition = false,
  factories = [],
  children,
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
  const returnValues = searchParams?.getAll("returnTo");
  const returnParam = returnValues?.length === 1 ? returnValues[0] : null;
  const locationHash = useSyncExternalStore(
    subscribeToLocationHash,
    () => window.location.hash,
    () => "",
  );
  const router = useRouter();
  const { startNavigation } = useOptionalRouteProgress();
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
  const location = matchWorkspaceLocation(pathname, workspace.slug);
  const factoryRequest = readFactoryRequest(searchParams);
  const { snapshot, publish } = useWorkspaceScopeSnapshot(
    viewerId,
    workspace.id,
    workspaceScopeLocationKey(pathname, location?.detail ? undefined : factoryRequest),
  );
  const currentFactories = snapshot?.factories ?? factories;
  const scoped = snapshot?.scope ?? { kind: "global" };
  const globalScope = location?.mode === "global";
  const remembered = useRememberedWorkspaceScope({
    factories: currentFactories,
    snapshot,
    viewerId,
    workspaceId: workspace.id,
  });
  const { activeItem, sections, sidebar, tabs } = getGroupedWorkspaceNavigation({
    canManageDefinition: canManageFactoryDefinition,
    factories: currentFactories,
    hash: locationHash,
    pathname,
    preferRememberedScope: globalScope,
    returnTo: returnParam,
    scope: globalScope ? remembered : scoped,
    workspaceSlug: workspace.slug,
  });
  const [guardedPickerTarget, setGuardedPickerTarget] = useState<HTMLDivElement | null>(null);
  const scopeContext = useMemo(
    () => ({
      guardedPicker: snapshot?.picker === "guarded" ? { target: guardedPickerTarget } : null,
      ownsPicker: snapshot?.picker === "header",
      publish,
    }),
    [guardedPickerTarget, publish, snapshot?.picker],
  );
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

  const sessionsBrowse = location?.destination === "sessions" && !location.detail;
  const creationScope = useMemo<SessionCreationScope | null>(() => {
    if (!sessionsBrowse || !snapshot) return null;
    const { factories, scope } = snapshot;
    if (scope.kind === "all")
      return factories.some(({ status }) => status === "active") ? scope : null;
    if (scope.kind !== "factory" || scope.factory.status !== "active") return null;
    const { id, name } = scope.factory;
    return { kind: "factory", factory: { id, name } };
  }, [sessionsBrowse, snapshot]);
  const creationFactoryQuery =
    creationScope?.kind === "factory" ? creationScope.factory.id : creationScope?.kind;
  const createFromUrl = searchParams?.get("create") === "1";
  const urlWorkflowActivation = createFromUrl
    ? readSessionLaunchActivation(searchParams)
    : undefined;
  const composerKey = `${viewerId}:${workspace.id}`;
  const [userCreateOwner, setUserCreateOwner] = useState<string | null>(null);
  const [recoverableLaunch, setRecoverableLaunch] = useState<{
    composerKey: string;
    location: string;
    activationId?: string | null;
    returnTo: string | null;
  } | null>(null);
  const ownedLaunch = recoverableLaunch?.composerKey === composerKey ? recoverableLaunch : null;
  const launchOnLocation = ownedLaunch?.location === locationKey ? ownedLaunch : null;
  if (recoverableLaunch && (!ownedLaunch || (!createFromUrl && !launchOnLocation))) {
    setRecoverableLaunch(null);
  }
  const clearRecoverableLaunch = useCallback(() => setRecoverableLaunch(null), []);
  const returnTo = createFromUrl
    ? resolveSessionReturnTo(returnParam, workspace.slug)
    : (launchOnLocation?.returnTo ?? null);
  const workflowLaunchActivationId = createFromUrl
    ? urlWorkflowActivation
    : launchOnLocation?.activationId;
  const launchKey = JSON.stringify({ workflowLaunchActivationId, returnTo });
  const createUrlKey = JSON.stringify([composerKey, pathname, creationFactoryQuery, launchKey]);
  const [dismissedCreateUrlKey, setDismissedCreateUrlKey] = useState<string | null>(null);
  if (!createFromUrl && dismissedCreateUrlKey) setDismissedCreateUrlKey(null);
  // Leaving the direct scope closes the dialog but keeps it mounted: drafts and
  // attachments live inside it. Reopening takes an explicit new action.
  if (userCreateOwner !== null && (userCreateOwner !== composerKey || !creationScope)) {
    setUserCreateOwner(null);
  }
  const createOpen =
    creationScope !== null &&
    !shouldResumeSetup &&
    (userCreateOwner === composerKey || (createFromUrl && dismissedCreateUrlKey !== createUrlKey));
  const previewLocationKey = creationFactoryQuery && !shouldResumeSetup ? createUrlKey : null;
  const [creationPreview, setCreationPreview] = useState<{
    locationKey: string;
    preview: SessionCreationPreview;
  } | null>(null);
  const visibleCreationPreview =
    creationPreview?.locationKey === previewLocationKey ? creationPreview.preview : null;
  if (creationPreview && !visibleCreationPreview) setCreationPreview(null);
  const handleCreationPreview = useCallback(
    (preview: SessionCreationPreview | null) => {
      setCreationPreview(
        preview && previewLocationKey ? { locationKey: previewLocationKey, preview } : null,
      );
    },
    [previewLocationKey],
  );
  const handleCreateReopen = useCallback(
    (submittedFactoryId?: string) => {
      if (!submittedFactoryId) {
        setUserCreateOwner(composerKey);
        return;
      }
      const href = sessionLaunchHref(
        workspace.slug,
        submittedFactoryId,
        returnTo ?? undefined,
        workflowLaunchActivationId ?? undefined,
      );
      const recoveryKey = JSON.stringify([
        composerKey,
        sessionsHref,
        submittedFactoryId,
        launchKey,
      ]);
      setDismissedCreateUrlKey((dismissed) => (dismissed === recoveryKey ? null : dismissed));
      startNavigation(href);
      router.push(href);
    },
    [
      composerKey,
      launchKey,
      returnTo,
      router,
      sessionsHref,
      startNavigation,
      workflowLaunchActivationId,
      workspace.slug,
    ],
  );
  const [mountedComposer, setMountedComposer] = useState<{
    key: string;
    scope: SessionCreationScope;
  } | null>(null);
  if (
    creationScope &&
    (createOpen || mountedComposer?.key === composerKey) &&
    (mountedComposer?.key !== composerKey || mountedComposer.scope !== creationScope)
  )
    setMountedComposer({ key: composerKey, scope: creationScope });
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingFocusHref = useRef<string | null>(null);
  const committedLocation = useRef(locationKey);
  const createDialogPreloads = useRef<Set<string> | null>(null);
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
    if (pendingFocusHref.current !== locationKey) return;
    const frame = requestAnimationFrame(restoreCreateFocus);
    return () => cancelAnimationFrame(frame);
  }, [locationKey, restoreCreateFocus]);

  const handleCreateClose = useCallback(
    (reason?: "preview") => {
      setUserCreateOwner(null);
      const cleanHref = withoutSessionLaunch(pathname, search);
      if (createFromUrl) {
        setDismissedCreateUrlKey(createUrlKey);
      }
      if (reason === "preview") {
        if (createFromUrl) {
          setRecoverableLaunch({
            composerKey,
            location: cleanHref,
            activationId: urlWorkflowActivation,
            returnTo,
          });
          router.replace(cleanHref, { scroll: false });
        }
        return;
      }
      const destination =
        returnTo ??
        (createFromUrl && pathname !== sessionsHref
          ? workspaceSessionsPath(workspace.slug, { factory: creationFactoryQuery })
          : cleanHref + window.location.hash);
      clearRecoverableLaunch();
      pendingFocusHref.current = destination.split("#", 1)[0];
      if (!createFromUrl && pendingFocusHref.current === locationKey) return;
      router.replace(destination, { scroll: destination.split(/[?#]/u, 1)[0] !== pathname });
    },
    [
      clearRecoverableLaunch,
      composerKey,
      createFromUrl,
      createUrlKey,
      creationFactoryQuery,
      locationKey,
      pathname,
      returnTo,
      router,
      search,
      sessionsHref,
      urlWorkflowActivation,
      workspace.slug,
    ],
  );

  function preloadCreateDialog() {
    createDialogPreloads.current ??= new Set();
    preloadCreateSessionDialogOnce(createDialogPreloads.current, {
      userId: viewerId,
      workspaceId: workspace.id,
      factoryId: creationScope?.kind === "factory" ? creationScope.factory.id : undefined,
    });
  }

  function handleNavClick(event: MouseEvent<HTMLAnchorElement>, mobile: boolean) {
    if (!isUnmodifiedPrimaryClick(event)) return;
    visibleCreationPreview?.dismiss();
    if (mobile) setDrawerLocation(null);
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

  function navLinkProps(item: ShellNavItem, mobile = false) {
    const { href, id } = item;
    const skipPrefetch = id === "inbox" || id === "insights";
    return {
      href,
      // From the pipeline, load the real page ahead of the click. The default
      // stops at loading.tsx, and prefetching every page from every page
      // competes with opening a session.
      prefetch: skipPrefetch
        ? false
        : item !== activeItem && pathname === pipelineHref
          ? true
          : undefined,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => handleNavClick(event, mobile),
      ...(skipPrefetch ? {} : navPrefetchHandlers(href)),
    };
  }
  const scopedPipelineHref = workspaceScopeHref(
    "board",
    workspace.slug,
    globalScope ? remembered : scoped,
    globalScope,
  );

  function renderPrimaryAction() {
    if (!sessionsBrowse) return null;
    if (shouldResumeSetup) {
      return (
        <Link className="ui-button-primary min-h-9 px-2.5 text-[13px]" href={onboardingHref}>
          <span className="lg:hidden">Setup</span>
          <span className="hidden lg:inline">Resume setup</span>
        </Link>
      );
    }
    if (!creationScope) return null;

    return (
      <button
        ref={createTriggerRef}
        type="button"
        className="ui-button-primary inline-flex size-9 items-center justify-center gap-2 whitespace-nowrap px-0 lg:min-h-9 lg:w-auto lg:px-3"
        aria-label="New session"
        onClick={() => {
          startInteraction("open_create_dialog", interactionRouteTemplateForPath(pathname));
          setUserCreateOwner(composerKey);
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
    <WorkspaceScopeContext.Provider value={scopeContext}>
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
              {location && snapshot ? (
                <WorkspaceFactoryPicker
                  allowAll={location.mode === "aggregate" && !location.detail}
                  choices={workspaceScopeOptions(location, currentFactories)}
                  guardTarget={snapshot.picker === "guarded" ? setGuardedPickerTarget : undefined}
                  locked={snapshot.picker !== "header"}
                  resetParams={snapshot.resetParams}
                  scope={scoped}
                  visibleFactoryCount={currentFactories.length}
                />
              ) : null}
              {activeItem ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "hidden min-w-0 truncate border-l border-border pl-4 text-[13px] font-medium text-muted",
                    wideContent ? "xl:inline" : "lg:inline",
                  )}
                >
                  {activeItem.label}
                </span>
              ) : null}
              <Dialog
                open={drawerOpen}
                onOpenChange={(open) => setDrawerLocation(open ? locationKey : null)}
              >
                <DialogTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Workspace navigation: ${activeItem?.label ?? "Pages"}`}
                    className={cn(
                      "ui-shell-nav-link order-first min-h-11 min-w-10 justify-center px-2",
                      wideContent ? "xl:hidden" : "lg:hidden",
                    )}
                  >
                    <NavigationMenuIcon />
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
                    {snapshot &&
                    (scoped.kind === "all" ||
                      (scoped.kind === "factory" && currentFactories.length > 1)) ? (
                      <p className="min-w-0 px-2.5 type-secondary break-words text-muted">
                        {workspace.name} /{" "}
                        {scoped.kind === "all" ? "All factories" : scoped.factory.name}
                      </p>
                    ) : null}
                    <WorkspaceNavLinks
                      getLinkProps={(item) => navLinkProps(item, true)}
                      items={sidebar}
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
            getLinkProps={navLinkProps}
            items={sidebar}
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
            {activeItem ? (
              <WorkspaceGroupTabs label={activeItem.label} tabs={tabs} sections={sections} />
            ) : null}
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

      {mountedComposer?.key === composerKey ? (
        <CreateSessionDialog
          key={composerKey}
          creationScope={mountedComposer.scope}
          launchKey={launchKey}
          open={createOpen}
          onClose={handleCreateClose}
          onCloseAutoFocus={handleCreateCloseAutoFocus}
          onDraftReset={clearRecoverableLaunch}
          onPreviewChange={handleCreationPreview}
          onReopen={handleCreateReopen}
          userId={viewerId}
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          workflowLaunchActivationId={workflowLaunchActivationId}
        />
      ) : null}
    </WorkspaceScopeContext.Provider>
  );
}
