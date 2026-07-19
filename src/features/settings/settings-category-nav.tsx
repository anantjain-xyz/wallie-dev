"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

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
  "cloud-execution": { anchor: "verify", category: "advanced" },
  "coding-agent": { anchor: "runtime", category: "integrations" },
  "danger-zone": { anchor: "danger-zone", category: "workspace" },
  github: { anchor: "github", category: "integrations" },
  linear: { anchor: "linear", category: "integrations" },
  "linear-routing": { anchor: "linear", category: "integrations" },
  members: { anchor: "members", category: "workspace" },
  pipeline: { anchor: "pipeline", category: "pipeline" },
  "rate-limits": { anchor: "rate-limits", category: "advanced" },
  repository: { anchor: "repository", category: "integrations" },
  runtime: { anchor: "runtime", category: "integrations" },
  secrets: { anchor: "runtime", category: "integrations" },
  usage: { anchor: "usage", category: "advanced" },
  vercel: { anchor: "vercel", category: "integrations" },
  verify: { anchor: "verify", category: "advanced" },
  workspace: { anchor: "workspace", category: "workspace" },
};

export function resolveSettingsHashRoute(hash: string): SettingsHashRoute | null {
  const anchorId = hash.replace(/^#/u, "");
  return HASH_ROUTES[anchorId] ?? null;
}

export function preloadSettingsCategory(category: SettingsCategory) {
  switch (category) {
    case "integrations":
      void import("@/features/settings/islands/integration-islands");
      break;
    case "pipeline":
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

  return (
    <nav aria-label="Settings categories" className="sticky top-[var(--shell-scroll-padding)]">
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
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
