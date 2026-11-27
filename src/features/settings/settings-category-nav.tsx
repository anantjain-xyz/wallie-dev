"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import {
  SETTINGS_CATEGORY_LINKS,
  type SettingsCategory,
} from "@/features/settings/settings-categories";

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
  "connected-clients": { anchor: "connected-clients", category: "workspace" },
  "connector-resources": { anchor: "connector-resources", category: "integrations" },
  "coding-agent": { anchor: "runtime", category: "integrations" },
  "danger-zone": { anchor: "danger-zone", category: "workspace" },
  "factory-configuration": { anchor: "factory-configuration", category: "integrations" },
  github: { anchor: "github", category: "integrations" },
  linear: { anchor: "linear", category: "integrations" },
  "linear-routing": { anchor: "linear", category: "integrations" },
  maintenance: { anchor: "maintenance", category: "advanced" },
  members: { anchor: "members", category: "workspace" },
  pipeline: { anchor: "pipeline", category: "integrations" },
  profile: { anchor: "profile", category: "workspace" },
  "provider-access": { anchor: "provider-access", category: "integrations" },
  "rate-limits": { anchor: "rate-limits", category: "advanced" },
  repository: { anchor: "repository", category: "integrations" },
  "run-history": { anchor: "run-history", category: "advanced" },
  runtime: { anchor: "runtime", category: "integrations" },
  sandbox: { anchor: "sandbox", category: "integrations" },
  secrets: { anchor: "runtime", category: "integrations" },
  usage: { anchor: "usage", category: "advanced" },
  vercel: { anchor: "sandbox", category: "integrations" },
  verify: { anchor: "verify", category: "integrations" },
  workspace: { anchor: "workspace", category: "workspace" },
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
    { id: "provider-access", label: "Your provider access" },
    { id: "verify", label: "Verify setup" },
  ],
  workspace: [
    { id: "workspace", label: "Workspace" },
    { id: "members", label: "Team access" },
    { id: "profile", label: "Your profile" },
    { id: "connected-clients", label: "Connected clients" },
    { id: "danger-zone", label: "Danger zone" },
  ],
  advanced: [
    { id: "usage", label: "Usage" },
    { id: "run-history", label: "Retention and exports" },
    { id: "maintenance", label: "Maintenance" },
    { id: "rate-limits", label: "Rate limits" },
  ],
};

export function resolveSettingsHashRoute(hash: string): SettingsHashRoute | null {
  const anchorId = hash.replace(/^#/u, "");
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
      void import("@/features/settings/islands/workspace-islands");
      break;
  }
}

const managerAnchors = new Set(["run-history", "maintenance"]);

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
  const [jumpOpen, setJumpOpen] = useState(false);
  const jumpId = useId();
  const reachTarget = useCallback((target: HTMLElement) => {
    const heading = target.querySelector<HTMLElement>("[data-settings-heading]");
    heading?.focus({ preventScroll: true });
    setActiveAnchor(target.id);
    setJumpOpen(false);
    window.requestAnimationFrame(() => {
      if (target.isConnected) target.scrollIntoView({ block: "start" });
    });
  }, []);

  useEffect(() => {
    const submenu = settingsCategorySubmenu(activeCategory, canManage);
    let pending: { id: string; origin: Element | null } | null = null;

    function reachPendingHash() {
      if (!pending) return;
      const target = document.getElementById(pending.id);
      if (!target || target.closest("[hidden]")) return;
      const { origin } = pending;
      pending = null;
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
      for (const item of submenu) {
        const section = document.getElementById(item.id);
        if (!section || observedSections.has(section)) continue;
        observedSections.add(section);
        observer?.observe(section);
      }
      reachPendingHash();
    }

    observeMountedSections();
    const mutationObserver = new MutationObserver(observeMountedSections);
    mutationObserver.observe(document.getElementById("settings-sections") ?? document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      mutationObserver.disconnect();
      observer?.disconnect();
      window.removeEventListener("hashchange", syncActiveHash);
    };
  }, [activeCategory, canManage, pathname, reachTarget, router, search]);

  return (
    <nav
      aria-label="Settings categories"
      className="self-start lg:sticky lg:top-[calc(var(--shell-scroll-padding)+16px)] lg:max-h-[calc(100dvh-var(--shell-scroll-padding)-16px)] lg:overflow-y-auto"
    >
      <ul className="grid grid-cols-3 gap-1 lg:flex lg:flex-col lg:gap-2">
        {SETTINGS_CATEGORY_LINKS.map((category) => {
          const isActive = category.id === activeCategory;
          return (
            <li className="min-w-0" key={category.id}>
              <Link
                aria-current={isActive ? "page" : undefined}
                className="settings-anchor !block min-h-9 !px-2 text-center aria-[current=page]:bg-control-hover aria-[current=page]:text-foreground lg:!px-3 lg:text-left"
                href={`/w/${workspaceSlug}/settings?category=${category.id}`}
                onFocus={() => preloadSettingsCategory(category.id)}
                onPointerEnter={() => preloadSettingsCategory(category.id)}
              >
                <span className="block">{category.label}</span>
                <span className="mt-0.5 hidden font-normal leading-4 text-muted type-annotation lg:block">
                  {category.description}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        aria-controls={jumpId}
        aria-expanded={jumpOpen}
        className="settings-anchor mt-2 min-h-9 w-full lg:hidden"
        onClick={() => setJumpOpen(!jumpOpen)}
        type="button"
      >
        Jump to a section
        <ChevronDownIcon className={jumpOpen ? "rotate-180" : undefined} />
      </button>
      <ul
        className={`${jumpOpen ? "block" : "hidden lg:block"} ml-3 border-l border-border pl-2 lg:mt-4`}
        id={jumpId}
      >
        {settingsCategorySubmenu(activeCategory, canManage).map((item) => (
          <li key={item.id}>
            <a
              aria-current={item.id === activeAnchor ? "location" : undefined}
              className={`settings-anchor min-h-9 lg:min-h-0 ${item.id === activeAnchor ? "settings-anchor-active" : ""}`}
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
    </nav>
  );
}
