"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  SETTINGS_CATEGORY_LINKS,
  type SettingsCategory,
} from "@/features/settings/settings-categories";

type SettingsCategoryNavProps = {
  activeCategory: SettingsCategory;
  workspaceSlug: string;
};

type SettingsHashRoute = {
  anchor: string;
  category: SettingsCategory;
};

const HASH_ROUTES: Record<string, SettingsHashRoute> = {
  "cloud-execution": { anchor: "verify", category: "integrations" },
  "coding-agent": { anchor: "runtime", category: "integrations" },
  "danger-zone": { anchor: "danger-zone", category: "workspace" },
  github: { anchor: "github", category: "integrations" },
  linear: { anchor: "linear", category: "integrations" },
  "linear-routing": { anchor: "linear", category: "integrations" },
  maintenance: { anchor: "maintenance", category: "advanced" },
  members: { anchor: "members", category: "workspace" },
  pipeline: { anchor: "pipeline", category: "integrations" },
  "rate-limits": { anchor: "rate-limits", category: "advanced" },
  repository: { anchor: "repository", category: "integrations" },
  runtime: { anchor: "runtime", category: "integrations" },
  sandbox: { anchor: "sandbox", category: "integrations" },
  secrets: { anchor: "runtime", category: "integrations" },
  usage: { anchor: "usage", category: "advanced" },
  vercel: { anchor: "sandbox", category: "integrations" },
  verify: { anchor: "verify", category: "integrations" },
  workspace: { anchor: "workspace", category: "workspace" },
};

const SETTINGS_CATEGORY_SUBMENUS: Record<
  SettingsCategory,
  ReadonlyArray<{ id: string; label: string }>
> = {
  integrations: [
    { id: "github", label: "GitHub" },
    { id: "repository", label: "Repositories" },
    { id: "pipeline", label: "Pipeline" },
    { id: "linear", label: "Linear" },
    { id: "sandbox", label: "Sandbox" },
    { id: "runtime", label: "Agent" },
    { id: "verify", label: "Verify setup" },
  ],
  workspace: [
    { id: "workspace", label: "Workspace" },
    { id: "members", label: "Members" },
    { id: "danger-zone", label: "Danger zone" },
  ],
  advanced: [
    { id: "usage", label: "Usage" },
    { id: "maintenance", label: "Maintenance" },
    { id: "rate-limits", label: "Rate limits" },
  ],
};

export function resolveSettingsHashRoute(hash: string): SettingsHashRoute | null {
  const anchorId = hash.replace(/^#/u, "");
  return HASH_ROUTES[anchorId] ?? null;
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

export function SettingsCategoryNav({ activeCategory, workspaceSlug }: SettingsCategoryNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const search = useSearchParams().toString();
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);

  useEffect(() => {
    function routeHash() {
      const hash = window.location.hash.replace(/^#/u, "");
      const route = resolveSettingsHashRoute(hash);
      if (!route) return;

      const needsCategoryChange = route.category !== activeCategory;
      const needsAnchorRewrite = route.anchor !== hash;
      if (!needsCategoryChange && !needsAnchorRewrite) return;

      const next = new URLSearchParams(search);
      next.set("category", route.category);
      const query = next.toString();
      router.replace(`${pathname}?${query}#${route.anchor}`);
    }

    routeHash();
    window.addEventListener("hashchange", routeHash);
    return () => window.removeEventListener("hashchange", routeHash);
  }, [activeCategory, pathname, router, search]);

  useEffect(() => {
    const submenu = SETTINGS_CATEGORY_SUBMENUS[activeCategory];
    const submenuIds = new Set<string>(submenu.map((item) => item.id));

    function syncActiveHash() {
      const route = resolveSettingsHashRoute(window.location.hash);
      if (route?.category === activeCategory && submenuIds.has(route.anchor)) {
        setActiveAnchor(route.anchor);
      }
    }

    syncActiveHash();
    window.addEventListener("hashchange", syncActiveHash);

    if (!("IntersectionObserver" in window)) {
      return () => window.removeEventListener("hashchange", syncActiveHash);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveAnchor(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: [0, 1] },
    );
    const observedSections = new WeakSet<HTMLElement>();

    function observeMountedSections() {
      for (const item of submenu) {
        const section = document.getElementById(item.id);
        if (!section || observedSections.has(section)) continue;
        observedSections.add(section);
        observer.observe(section);
      }
    }

    observeMountedSections();
    const mutationObserver = new MutationObserver(observeMountedSections);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
      window.removeEventListener("hashchange", syncActiveHash);
    };
  }, [activeCategory]);

  return (
    <nav
      aria-label="Settings categories"
      className="self-start sticky top-[calc(var(--shell-scroll-padding)+16px)] max-h-[calc(100dvh-var(--shell-scroll-padding)-16px)] overflow-y-auto"
    >
      <ul className="grid grid-cols-2 gap-2 pb-2 lg:flex lg:flex-col lg:pb-0">
        {SETTINGS_CATEGORY_LINKS.map((category) => {
          const isActive = category.id === activeCategory;
          return (
            <li key={category.id}>
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`settings-anchor block min-w-0 ${
                  isActive ? "settings-anchor-active" : ""
                }`}
                href={`/w/${workspaceSlug}/settings?category=${category.id}`}
                onFocus={() => preloadSettingsCategory(category.id)}
                onPointerEnter={() => preloadSettingsCategory(category.id)}
              >
                <span className="block">{category.label}</span>
                <span className="mt-0.5 hidden font-normal leading-4 text-muted type-annotation lg:block">
                  {category.description}
                </span>
              </Link>
              {isActive ? (
                <ul className="ml-3 mt-1 hidden flex-col gap-0.5 border-l border-border pl-2 lg:flex">
                  {SETTINGS_CATEGORY_SUBMENUS[category.id].map((item) => {
                    const isSubmenuActive = item.id === activeAnchor;
                    return (
                      <li key={item.id}>
                        <a
                          aria-current={isSubmenuActive ? "location" : undefined}
                          className={`settings-anchor ${
                            isSubmenuActive ? "settings-anchor-active" : ""
                          }`}
                          href={`#${item.id}`}
                          onClick={() => setActiveAnchor(item.id)}
                        >
                          <span>{item.label}</span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
