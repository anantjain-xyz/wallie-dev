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
  LazyCreateSessionDialog,
  NewSessionButton,
} from "@/components/app-shell/new-session-action";
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
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import {
  shouldShowOnboardingResumeCta,
  type OnboardingResumeState,
} from "@/features/onboarding/resume";
import type { WorkspaceSummary } from "@/lib/auth";
import { workspaceBasePath, workspaceOnboardingPath, workspaceSessionsPath } from "@/lib/routes";
import { isUnmodifiedPrimaryClick } from "@/lib/telemetry/interaction-rum";
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
  const scopeLocationKey = workspaceScopeLocationKey(
    pathname,
    location?.detail ? undefined : factoryRequest,
  );
  const { snapshot, publish } = useWorkspaceScopeSnapshot(viewerId, workspace.id, scopeLocationKey);
  const currentFactories = snapshot?.factories ?? factories;
  const scopeChoices =
    location && snapshot ? workspaceScopeOptions(location, currentFactories) : [];
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
  const scopeMode = location?.mode;
  const browseCreationScope = useMemo<SessionCreationScope | null>(() => {
    if (!scopeMode || scopeMode === "global") return { kind: "all" };
    const scope = snapshot?.scope;
    if (!scope || scope.kind === "resource-pending") return null;
    if (scope.kind === "factory") {
      const { id, name, status } = scope.factory;
      return status === "active"
        ? { kind: "factory", factory: { id, name } }
        : { kind: "unavailable" };
    }
    return { kind: scope.kind === "unavailable" ? "unavailable" : "all" };
  }, [scopeMode, snapshot]);
  const createFromUrl = sessionsBrowse && searchParams?.get("create") === "1";
  const urlWorkflowActivation = createFromUrl
    ? readSessionLaunchActivation(searchParams)
    : undefined;
  const composerKey = `${viewerId}:${workspace.id}`;
  const committedLocation = useRef(locationKey);
  const [userCreateOwner, setUserCreateOwner] = useState<{ key: string; location: string } | null>(
    null,
  );
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
  const requestedWorkflow = createFromUrl ? urlWorkflowActivation : launchOnLocation?.activationId;
  const wantsLaunch = createFromUrl || Boolean(launchOnLocation);
  const launchScope = useMemo<SessionCreationScope | null>(() => {
    if (!wantsLaunch || !sessionsBrowse || !snapshot) return null;
    if (browseCreationScope?.kind === "factory") {
      return { kind: "pinned", factory: browseCreationScope.factory };
    }
    return snapshot.scope.kind === "all" &&
      requestedWorkflow === undefined &&
      snapshot.factories.some(({ status }) => status === "active")
      ? { kind: "all" }
      : null;
  }, [browseCreationScope, requestedWorkflow, sessionsBrowse, snapshot, wantsLaunch]);
  const launchFromUrl = createFromUrl && launchScope !== null;
  const returnTo = launchFromUrl
    ? resolveSessionReturnTo(returnParam, workspace.slug)
    : launchScope
      ? (launchOnLocation?.returnTo ?? null)
      : null;
  const workflowLaunchActivationId = launchScope ? requestedWorkflow : undefined;
  const launchKey = JSON.stringify({ workflowLaunchActivationId, returnTo });
  const creationScope = launchScope ?? browseCreationScope;
  const creationFactoryId =
    creationScope?.kind === "factory" || creationScope?.kind === "pinned"
      ? creationScope.factory.id
      : undefined;
  const creationFactoryQuery = creationFactoryId ?? creationScope?.kind;
  const createUrlKey = JSON.stringify([composerKey, pathname, creationFactoryQuery, launchKey]);
  const [dismissedCreateUrlKey, setDismissedCreateUrlKey] = useState<string | null>(null);
  if (!createFromUrl && dismissedCreateUrlKey) setDismissedCreateUrlKey(null);
  const ownsOpenDialog =
    userCreateOwner?.key === composerKey && userCreateOwner.location === locationKey;
  if (userCreateOwner !== null && (!ownsOpenDialog || !creationScope)) {
    setUserCreateOwner(null);
  }
  const createDisabledReason = shouldResumeSetup
    ? "Complete workspace setup before starting a session."
    : !creationScope
      ? "Waiting for this page’s factory."
      : undefined;
  const createOpen =
    !createDisabledReason &&
    (ownsOpenDialog || (launchFromUrl && dismissedCreateUrlKey !== createUrlKey));
  const previewLocationKey = createDisabledReason
    ? null
    : launchScope
      ? createUrlKey
      : JSON.stringify([composerKey, locationKey, creationFactoryQuery]);
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
        setUserCreateOwner({ key: composerKey, location: committedLocation.current });
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
  const pendingCreateFocus = useRef<{ location: string; preferLauncher: boolean } | null>(null);
  const prefetchedNavKeysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (shouldResumeSetup && createFromUrl) {
      router.replace(onboardingHref);
    }
  }, [createFromUrl, onboardingHref, router, shouldResumeSetup]);

  const restoreCreateFocus = useCallback(() => {
    const pending = pendingCreateFocus.current;
    if (pending?.location !== committedLocation.current) return;
    const target =
      (pending.preferLauncher && !createTriggerRef.current?.disabled
        ? createTriggerRef.current
        : null) ?? mainRef.current;
    target?.focus({ preventScroll: true });
    if (target === document.activeElement) pendingCreateFocus.current = null;
  }, []);

  const handleCreateCloseAutoFocus = useCallback(() => {
    requestAnimationFrame(restoreCreateFocus);
  }, [restoreCreateFocus]);

  useEffect(() => {
    committedLocation.current = locationKey;
    if (pendingCreateFocus.current?.location !== locationKey) return;
    const frame = requestAnimationFrame(restoreCreateFocus);
    return () => cancelAnimationFrame(frame);
  }, [locationKey, restoreCreateFocus]);

  const handleCreateClose = useCallback(
    (reason?: "preview") => {
      setUserCreateOwner(null);
      const cleanHref = launchFromUrl ? withoutSessionLaunch(pathname, search) : locationKey;
      if (launchFromUrl) {
        setDismissedCreateUrlKey(createUrlKey);
      }
      if (reason === "preview") {
        if (launchFromUrl) {
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
        (launchFromUrl && pathname !== sessionsHref
          ? workspaceSessionsPath(workspace.slug, { factory: creationFactoryQuery })
          : cleanHref + window.location.hash);
      clearRecoverableLaunch();
      const focusLocation = destination.split("#", 1)[0];
      pendingCreateFocus.current = { location: focusLocation, preferLauncher: !returnTo };
      if (!launchFromUrl && focusLocation === locationKey) return;
      router.replace(destination, { scroll: destination.split(/[?#]/u, 1)[0] !== pathname });
    },
    [
      clearRecoverableLaunch,
      composerKey,
      createUrlKey,
      creationFactoryQuery,
      launchFromUrl,
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
                  choices={scopeChoices}
                  guardTarget={snapshot.picker === "guarded" ? setGuardedPickerTarget : undefined}
                  locked={snapshot.picker !== "header"}
                  resetParams={snapshot.resetParams}
                  scope={scoped}
                  visibleFactoryCount={
                    location.route === "automations" ? scopeChoices.length : currentFactories.length
                  }
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
              {shouldResumeSetup ? (
                <Link
                  className={cn(
                    sessionsBrowse ? "ui-button-primary" : "ui-button",
                    "min-h-9 px-2.5 text-[13px]",
                  )}
                  href={onboardingHref}
                >
                  <span className="lg:hidden">Setup</span>
                  <span className="hidden lg:inline">Resume setup</span>
                </Link>
              ) : null}
              <NewSessionButton
                disabledReason={createDisabledReason}
                factoryId={creationFactoryId}
                onOpen={() => setUserCreateOwner({ key: composerKey, location: locationKey })}
                pathname={pathname}
                ref={createTriggerRef}
                userId={viewerId}
                workspaceId={workspace.id}
              />
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
              <WorkspaceGroupTabs
                label={activeItem.label}
                sections={sections}
                singleRow={activeItem.id === "factory"}
                tabs={tabs}
              />
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
        <LazyCreateSessionDialog
          key={composerKey}
          creationContextKey={scopeLocationKey}
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
