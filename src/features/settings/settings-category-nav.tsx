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

const HASH_CATEGORIES: Record<string, SettingsCategory> = {
  "cloud-execution": "advanced",
  "coding-agent": "integrations",
  "danger-zone": "workspace",
  github: "integrations",
  linear: "integrations",
  "linear-routing": "integrations",
  members: "workspace",
  pipeline: "pipeline",
  "rate-limits": "advanced",
  repository: "integrations",
  runtime: "integrations",
  secrets: "integrations",
  usage: "advanced",
  vercel: "integrations",
  verify: "advanced",
  workspace: "workspace",
};

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
    const hash = window.location.hash.replace(/^#/u, "");
    const hashCategory = HASH_CATEGORIES[hash];
    if (!hashCategory || hashCategory === activeCategory) return;
    const next = new URLSearchParams(search);
    next.set("category", hashCategory);
    router.replace(`${pathname}?${next.toString()}#${hash}`);
  }, [activeCategory, pathname, router, search]);

  return (
    <nav aria-label="Settings categories" className="sticky top-6">
      <ul className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
        {SETTINGS_CATEGORY_LINKS.map((category) => {
          const isActive = category.id === activeCategory;
          return (
            <li key={category.id}>
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`settings-anchor block min-w-36 lg:min-w-0 ${
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
