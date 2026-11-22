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
} from "react";

import { AccountMenu } from "@/components/app-shell/account-menu";
import { ThemeToggle } from "@/components/app-shell/theme-toggle";
import { RouteEntrance } from "@/components/app-shell/navigation-motion";
import {
  NavigationMenuIcon,
  WorkspaceNavLinks,
  WorkspaceSidebar,
} from "@/components/app-shell/workspace-sidebar";
import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import {
  defaultsToAllFactories,
  FACTORY_QUERY_PARAM,
  isFactoryAggregatePath,
  isFactorySelectorPath,
  isManagedFactoryPath,
  withFactoryQuery,
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
  workspaceRunsPath,
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
  children?: ReactNode;
  factorySelector?: ReactNode;
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
  creationFactory,
  children,
  factorySelector,
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
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const wideContent = pathname.startsWith(`${workspaceSessionsPath(workspace.slug)}/`);
  const sidebarMediaQuery = wideContent ? "(min-width: 80rem)" : "(min-width: 64rem)";
  const locationKey = `${pathname}?${searchParams?.toString() ?? ""}`;
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
  const factory = searchParams?.getAll(FACTORY_QUERY_PARAM) ?? [];
  const isDirectCreationScope =
    creationFactory !== null &&
    (factory.length > 0
      ? factory.length === 1 && factory[0].toLowerCase() === creationFactory.id
      : !defaultsToAllFactories(pathname, workspace.slug) &&
        !isManagedFactoryPath(pathname, workspace.slug));
  // Unscoped session/run detail pages can belong to any factory, so creation
  // stays available but names its default-factory destination up front.
  const isAmbiguousCreationScope =
    isDirectCreationScope &&
    factory.length === 0 &&
    (pathname.startsWith(`${workspaceSessionsPath(workspace.slug)}/`) ||
      pathname.startsWith(`${workspaceRunsPath(workspace.slug)}/`));
  const createFromUrl = searchParams?.get("create") === "1";
  const [userCreateOpen, setUserCreateOpen] = useState(false);
  const createScope = `${viewerId}:${workspace.id}`;
  const createUrlKey = `${createScope}:${pathname}`;
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
  const createButtonRef = useRef<HTMLButtonElement>(null);
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
      createButtonRef.current?.focus();
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
  const scopedPipelineHref = withFactoryQuery(pipelineHref, factory);

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
    const scopedFactory = factory?.length === 1 && factory[0] === "all" ? undefined : factory;
    const href = isFactoryAggregatePath(item.href, workspace.slug)
      ? withFactoryQuery(item.href, factory)
      : item.id === "agents" ||
          item.id === "scorers" ||
          item.id === "analytics" ||
          item.id === "benchmarks" ||
          item.id === "failure-groups" ||
          item.id === "improvements" ||
          item.id === "overview" ||
          item.id === "factory-definition" ||
          isManagedFactoryPath(item.href, workspace.slug)
        ? withFactoryQuery(item.href, scopedFactory)
        : item.href;
    const skipPrefetch = item.id === "inbox" || item.id === "analytics" || item.id === "overview";
    return {
      href,
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

    if (!isDirectCreationScope) {
      const creationSwitchHref = workspaceSessionsPath(workspace.slug, {
        factory: creationFactory.id,
        create: 1,
      });
      return (
        <Link
          aria-label={`Switch to create in ${creationFactory.name}`}
          className="ui-button-primary inline-flex min-h-9 items-center justify-center gap-2 whitespace-nowrap px-2.5 text-[13px]"
          href={creationSwitchHref}
          onClick={(event) => {
            if (isUnmodifiedPrimaryClick(event)) visibleCreationPreview?.dismiss();
          }}
          {...navPrefetchHandlers(creationSwitchHref)}
        >
          <PlusIcon className="h-3.5 w-3.5" />
          <span className="max-w-48 truncate">
            Switch to create
            <span className="hidden lg:inline"> in {creationFactory.name}</span>
          </span>
        </Link>
      );
    }

    return (
      <button
        ref={createButtonRef}
        type="button"
        className={cn(
          "ui-button-primary inline-flex items-center justify-center gap-2 whitespace-nowrap",
          isAmbiguousCreationScope
            ? "min-h-9 w-auto max-w-full px-2.5 text-[13px]"
            : "size-9 px-0 lg:min-h-9 lg:w-auto lg:px-3",
        )}
        aria-label={
          isAmbiguousCreationScope ? `New session in ${creationFactory.name}` : "New session"
        }
        onClick={() => {
          startInteraction("open_create_dialog", interactionRouteTemplateForPath(pathname));
          setUserCreateOpen(true);
        }}
        onFocus={preloadCreateDialog}
        onPointerEnter={preloadCreateDialog}
      >
        <PlusIcon className="h-3.5 w-3.5" />
        {isAmbiguousCreationScope ? (
          <span className="max-w-48 truncate">New session in {creationFactory.name}</span>
        ) : (
          <span className="hidden lg:inline">New session</span>
        )}
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
              <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground lg:hidden">
                {workspace.name}
              </p>
              <Tooltip content={workspace.name}>
                <Link
                  href={scopedPipelineHref}
                  onClick={(event) => {
                    if (isUnmodifiedPrimaryClick(event)) visibleCreationPreview?.dismiss();
                  }}
                  {...navPrefetchHandlers(scopedPipelineHref)}
                  className="hidden min-w-0 max-w-48 items-center gap-2 rounded-[6px] py-1 hover:opacity-80 lg:flex"
                >
                  <WorkspaceAvatar name={workspace.name} url={workspaceAvatarUrl} />
                  <span className="truncate text-[13px] font-medium text-foreground">
                    {workspace.name}
                  </span>
                </Link>
              </Tooltip>
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
            {factorySelector && isFactorySelectorPath(pathname, workspace.slug) ? (
              <div className="min-w-0 basis-full pb-1 sm:basis-auto sm:pb-0">{factorySelector}</div>
            ) : null}
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
        <CreateSessionLoadingCloseContext.Provider
          value={{ onClose: handleCreateClose, open: createOpen }}
        >
          <CreateSessionDialog
            key={createScope}
            creationFactoryName={creationFactory.name}
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
