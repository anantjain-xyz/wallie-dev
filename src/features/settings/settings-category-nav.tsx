"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useId, useState } from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { useFactoryManagementLeaveGuard } from "@/features/settings/islands/factory-management-navigation";
import {
  FACTORY_ROW_ANCHOR_PREFIX,
  SETTINGS_CATEGORY_LINKS,
  type SettingsCategory,
} from "@/features/settings/settings-categories";
import { usePersonalSettingsGuard } from "@/features/settings/personal-settings-navigation";

type SettingsCategoryNavProps = {
  activeCategory: SettingsCategory;
  canManage: boolean;
  workspaceSlug: string;
};

type SettingsHashRoute = {
  anchor: string;
  category: SettingsCategory;
};

const HASH_ROUTES: Record<string, SettingsHashRoute> = {
  "cloud-execution": { anchor: "verify", category: "integrations" },
  "connected-clients": { anchor: "connected-clients", category: "personal" },
  "connector-resources": { anchor: "connector-resources", category: "integrations" },
  "coding-agent": { anchor: "runtime", category: "integrations" },
  "danger-zone": { anchor: "danger-zone", category: "workspace" },
  factories: { anchor: "factories", category: "workspace" },
  "factory-configuration": { anchor: "factory-configuration", category: "integrations" },
  "factory-management": { anchor: "factory-management", category: "workspace" },
  "factory-setup": { anchor: "factory-setup", category: "workspace" },
  github: { anchor: "github", category: "integrations" },
  linear: { anchor: "linear", category: "integrations" },
  "linear-routing": { anchor: "linear", category: "integrations" },
  maintenance: { anchor: "maintenance", category: "advanced" },
  members: { anchor: "members", category: "workspace" },
  "oauth-clients": { anchor: "oauth-clients", category: "workspace" },
  pipeline: { anchor: "pipeline", category: "integrations" },
  profile: { anchor: "profile", category: "personal" },
  "provider-access": { anchor: "provider-access", category: "personal" },
  "rate-limits": { anchor: "rate-limits", category: "advanced" },
  repository: { anchor: "repository", category: "integrations" },
  "run-history": { anchor: "run-history", category: "advanced" },
  runtime: { anchor: "runtime", category: "integrations" },
  sandbox: { anchor: "sandbox", category: "integrations" },
  secrets: { anchor: "workspace-secrets", category: "integrations" },
  usage: { anchor: "usage", category: "advanced" },
  vercel: { anchor: "sandbox", category: "integrations" },
  verify: { anchor: "verify", category: "integrations" },
  workspace: { anchor: "workspace", category: "workspace" },
  "workspace-oauth-connections": { anchor: "workspace-oauth-connections", category: "workspace" },
  "workspace-secrets": { anchor: "workspace-secrets", category: "integrations" },
};

const SETTINGS_CATEGORY_SUBMENUS: Record<
  SettingsCategory,
  ReadonlyArray<{ id: string; label: string }>
> = {
  integrations: [
    { id: "github", label: "GitHub" },
    { id: "repository", label: "Repositories" },
    { id: "linear", label: "Linear" },
    { id: "sandbox", label: "Sandbox connections" },
    { id: "workspace-secrets", label: "Workspace secrets" },
    { id: "connector-resources", label: "Factory connectors" },
    { id: "factory-configuration", label: "Default factory" },
    { id: "pipeline", label: "Pipeline" },
    { id: "runtime", label: "Agent runtime" },
    { id: "verify", label: "Verify setup" },
  ],
  workspace: [
    { id: "workspace", label: "General" },
    { id: "factories", label: "Factories" },
    { id: "members", label: "Members" },
    { id: "oauth-clients", label: "OAuth clients" },
    { id: "workspace-oauth-connections", label: "OAuth connections" },
    { id: "danger-zone", label: "Danger zone" },
  ],
  advanced: [
    { id: "usage", label: "Usage" },
    { id: "run-history", label: "Retention and exports" },
    { id: "maintenance", label: "Maintenance" },
    { id: "rate-limits", label: "Rate limits" },
  ],
  personal: [
    { id: "profile", label: "Profile" },
    { id: "provider-access", label: "Provider access" },
    { id: "connected-clients", label: "Connected clients" },
  ],
};

function isFactoryRowAnchor(anchor: string) {
  return (
    anchor.startsWith(FACTORY_ROW_ANCHOR_PREFIX) &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
      anchor.slice(FACTORY_ROW_ANCHOR_PREFIX.length),
    )
  );
}

export function resolveSettingsHashRoute(hash: string): SettingsHashRoute | null {
  const anchorId = hash.replace(/^#/u, "");
  if (isFactoryRowAnchor(anchorId)) return { anchor: anchorId, category: "workspace" };
  return Object.hasOwn(HASH_ROUTES, anchorId) ? HASH_ROUTES[anchorId] : null;
}

export function preloadSettingsCategory(category: SettingsCategory) {
  switch (category) {
    case "integrations":
      void import("@/features/settings/islands/integration-islands");
      void import("@/features/settings/islands/pipeline-island").then((module) =>
        module.preloadPipelineEditor(),
      );
      break;
    case "advanced":
      void import("@/features/settings/islands/advanced-islands");
      break;
    case "workspace":
    case "personal":
      void import("@/features/settings/islands/workspace-islands");
      break;
  }
}

const managerAnchors = new Set([
  "run-history",
  "maintenance",
  "oauth-clients",
  "workspace-oauth-connections",
]);

const mobileWorkspacePlacement = {
  integrations: { column: "col-start-1", outline: "max-lg:justify-self-start" },
  workspace: { column: "col-start-2", outline: "max-lg:justify-self-center" },
  advanced: { column: "col-start-3", outline: "max-lg:justify-self-end" },
};

function settingsCategorySubmenu(category: SettingsCategory, canManage: boolean) {
  const submenu = SETTINGS_CATEGORY_SUBMENUS[category];
  return canManage ? submenu : submenu.filter((item) => !managerAnchors.has(item.id));
}

export function SettingsCategoryNav({
  activeCategory,
  canManage,
  workspaceSlug,
}: SettingsCategoryNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams().toString();
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  const [mountedSectionIds, setMountedSectionIds] = useState<string[]>([]);
  const { stopNavigation: stopPersonalNavigation, warning: personalWarning } =
    usePersonalSettingsGuard();
  const { blocked: factoryNavigationBlocked, confirmLeave: confirmFactoryLeave } =
    useFactoryManagementLeaveGuard();
  const confirmFactoryHashLeave = useEffectEvent(confirmFactoryLeave);
  const activeSection =
    activeAnchor === "factory-setup" ||
    activeAnchor === "factory-management" ||
    (activeAnchor && isFactoryRowAnchor(activeAnchor))
      ? "factories"
      : activeAnchor;
  const [jumpOpen, setJumpOpen] = useState(false);
  const jumpId = useId();
  const outline = settingsCategorySubmenu(activeCategory, canManage).filter(({ id }) =>
    mountedSectionIds.includes(id),
  );
  const reachTarget = useCallback((target: HTMLElement) => {
    const heading = target.querySelector<HTMLElement>("[data-settings-heading]");
    heading?.focus({ preventScroll: true });
    setActiveAnchor(target.id);
    setJumpOpen(false);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (target.isConnected) target.scrollIntoView({ block: "start" });
      });
    });
  }, []);

  useEffect(() => {
    const submenu = settingsCategorySubmenu(activeCategory, canManage);
    const sections = document.getElementById("settings-sections") ?? document.body;
    let mountedKey: string | undefined;
    let pending: { id: string; origin: Element | null } | null = null;

    function reachPendingHash() {
      if (!pending) return;
      const target = document.getElementById(pending.id);
      if (!target || target.closest("[hidden]")) return;
      const { origin } = pending;
      pending = null;
      if (
        (target.id === "factory-management" || isFactoryRowAnchor(target.id)) &&
        target.contains(origin)
      ) {
        return;
      }
      if (document.activeElement === origin || document.activeElement === document.body) {
        reachTarget(target);
      }
    }

    function syncActiveHash() {
      const hash = window.location.hash;
      const route = resolveSettingsHashRoute(hash);
      pending = null;
      if (!route || (!canManage && managerAnchors.has(route.anchor))) {
        setActiveAnchor(null);
        return;
      }
      if (
        route.category !== activeCategory &&
        ((route.category === "personal" && stopPersonalNavigation()) || !confirmFactoryHashLeave())
      ) {
        const editorHash =
          activeCategory === "workspace" && new URLSearchParams(search).has("manageFactory")
            ? "#factory-management"
            : "";
        window.history.replaceState(null, "", pathname + window.location.search + editorHash);
        return;
      }
      if (route.category !== activeCategory || hash !== `#${route.anchor}`) {
        const next = new URLSearchParams(search);
        next.set("category", route.category);
        router.replace(`${pathname}?${next}#${route.anchor}`, { scroll: false });
      }
      if (route.category !== activeCategory) return;
      setActiveAnchor(route.anchor);
      pending = { id: route.anchor, origin: document.activeElement };
      reachPendingHash();
    }

    syncActiveHash();
    window.addEventListener("hashchange", syncActiveHash);

    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              if (window.location.hash) return;
              const visible = entries
                .filter((entry) => entry.isIntersecting)
                .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
              if (visible[0]) setActiveAnchor(visible[0].target.id);
            },
            { rootMargin: "-80px 0px -60% 0px", threshold: [0, 1] },
          )
        : null;
    const observedSections = new WeakSet<HTMLElement>();

    function observeMountedSections() {
      const ids: string[] = [];
      for (const item of submenu) {
        const section = document.getElementById(item.id);
        if (!section || !sections.contains(section) || section.closest("[hidden]")) continue;
        ids.push(item.id);
        if (observedSections.has(section)) continue;
        observedSections.add(section);
        observer?.observe(section);
      }
      const key = ids.join(" ");
      if (key !== mountedKey) {
        mountedKey = key;
        setMountedSectionIds((current) => (current.join(" ") === key ? current : ids));
      }
      reachPendingHash();
    }

    observeMountedSections();
    const mutationObserver = new MutationObserver(observeMountedSections);
    mutationObserver.observe(sections, {
      attributes: true,
      attributeFilter: ["hidden"],
      childList: true,
      subtree: true,
    });

    return () => {
      mutationObserver.disconnect();
      observer?.disconnect();
      window.removeEventListener("hashchange", syncActiveHash);
    };
  }, [activeCategory, canManage, pathname, reachTarget, router, search, stopPersonalNavigation]);

  return (
    <nav
      aria-label="Settings categories"
      className="min-w-0 self-start lg:sticky lg:top-[calc(var(--shell-scroll-padding)+16px)] lg:max-h-[calc(100dvh-var(--shell-scroll-padding)-16px)] lg:overflow-y-auto lg:p-1"
    >
      <ul className="grid grid-cols-3 items-start gap-x-1.5 lg:flex lg:flex-col lg:items-stretch lg:gap-1.5">
        {SETTINGS_CATEGORY_LINKS.map((category) => {
          const isActive = category.id === activeCategory;
          const hasOutline = isActive && outline.length > 0;
          const placement =
            category.id === "personal" ? null : mobileWorkspacePlacement[category.id];
          const spansWorkspaceRow = placement && hasOutline;
          return (
            <li
              className={`min-w-0 ${
                !placement
                  ? "col-span-full row-start-3 mt-2 lg:mt-2.5"
                  : spansWorkspaceRow
                    ? "col-span-full row-span-2 row-start-1 grid grid-cols-subgrid grid-rows-subgrid max-lg:pointer-events-none lg:block"
                    : `row-start-1 ${placement.column}`
              }`}
              key={category.id}
            >
              <Link
                aria-current={isActive ? "page" : undefined}
                aria-disabled={factoryNavigationBlocked || undefined}
                className={`settings-anchor min-h-11 touch-manipulation aria-[current=page]:bg-control-muted aria-[current=page]:font-semibold aria-[current=page]:text-foreground lg:min-h-9 ${
                  placement
                    ? "max-lg:h-full max-lg:justify-center max-lg:px-2 max-lg:text-center"
                    : ""
                } ${
                  spansWorkspaceRow
                    ? `${placement.column} row-start-1 pointer-events-auto max-lg:relative max-lg:after:absolute max-lg:after:inset-s-1/2 max-lg:after:top-full max-lg:after:h-1.5 max-lg:after:w-px max-lg:after:bg-border-strong`
                    : ""
                }`}
                href={`/w/${workspaceSlug}/settings?category=${category.id}`}
                onFocus={() => preloadSettingsCategory(category.id)}
                onNavigate={(event) => {
                  if (
                    (category.id === "personal" && stopPersonalNavigation()) ||
                    !confirmFactoryLeave()
                  ) {
                    event.preventDefault();
                  }
                }}
                onPointerEnter={() => preloadSettingsCategory(category.id)}
              >
                {category.label}
              </Link>
              {category.id === "personal" ? personalWarning : null}
              {hasOutline ? (
                <div
                  className={`col-span-full mt-1.5 lg:mt-1 ${
                    placement
                      ? `row-start-2 pointer-events-auto max-lg:w-2/3 max-lg:min-w-[min(100%,12rem)] ${placement.outline}`
                      : "max-lg:ml-2"
                  }`}
                >
                  <button
                    aria-controls={jumpId}
                    aria-expanded={jumpOpen}
                    className="settings-anchor min-h-11 w-full touch-manipulation bg-control-hover lg:hidden"
                    onClick={() => setJumpOpen(!jumpOpen)}
                    type="button"
                  >
                    Jump to a section
                    <ChevronDownIcon className={jumpOpen ? "rotate-180" : undefined} />
                  </button>
                  <ul
                    className={`${jumpOpen ? "block" : "hidden lg:block"} ml-2 border-l border-border pl-1.5`}
                    id={jumpId}
                  >
                    {outline.map((item) => (
                      <li key={item.id}>
                        <a
                          aria-current={item.id === activeSection ? "location" : undefined}
                          className={`settings-anchor min-h-11 touch-manipulation lg:min-h-0 ${item.id === activeSection ? "settings-anchor-active" : ""}`}
                          href={`#${item.id}`}
                          onClick={(event) => {
                            if (
                              event.button === 0 &&
                              !event.metaKey &&
                              !event.ctrlKey &&
                              !event.shiftKey &&
                              !event.altKey &&
                              window.location.hash === event.currentTarget.hash
                            ) {
                              const target = document.getElementById(item.id);
                              if (target) {
                                event.preventDefault();
                                reachTarget(target);
                              }
                            }
                          }}
                        >
                          {item.label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
