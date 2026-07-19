"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { SelectField } from "@/components/ui/select";
import {
  SETTINGS_CATEGORY_LINKS,
  type SettingsCategory,
} from "@/features/settings/settings-categories";
import { useConfirmSettingsLeave } from "@/features/settings/settings-dirty-registry";
import { resolveSettingsHashRoute } from "@/features/settings/settings-hash-routes";
import { workspaceSettingsCategoryPath } from "@/lib/routes";

type SettingsCategoryNavProps = {
  activeCategory: SettingsCategory;
  workspaceSlug: string;
};

export { resolveSettingsHashRoute } from "@/features/settings/settings-hash-routes";

export function preloadSettingsCategory(category: SettingsCategory) {
  switch (category) {
    case "integrations":
      void import("@/features/settings/islands/integration-islands");
      break;
    case "agent-execution":
      void import("@/features/settings/islands/integration-islands");
      break;
    case "pipeline":
      void import("@/features/settings/islands/pipeline-island").then((module) =>
        module.preloadPipelineEditor(),
      );
      break;
    case "advanced":
      void import("@/features/settings/islands/advanced-islands");
      void import("@/features/settings/islands/workspace-islands");
      break;
    case "general":
    case "members":
      void import("@/features/settings/islands/workspace-islands");
      break;
  }
}

function categoryHref(workspaceSlug: string, category: SettingsCategory, hash?: string) {
  const path = workspaceSettingsCategoryPath(workspaceSlug, category);
  return hash ? `${path}#${hash}` : path;
}

export function SettingsCategoryNav({ activeCategory, workspaceSlug }: SettingsCategoryNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const confirmLeaveIfDirty = useConfirmSettingsLeave();

  useEffect(() => {
    function routeHash() {
      const hash = window.location.hash.replace(/^#/u, "");
      const route = resolveSettingsHashRoute(hash);
      if (!route) return;

      const needsCategoryChange = route.category !== activeCategory;
      const needsAnchorRewrite = route.anchor !== hash;
      if (!needsCategoryChange && !needsAnchorRewrite) return;

      if (needsCategoryChange && !confirmLeaveIfDirty()) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
        return;
      }

      router.replace(categoryHref(workspaceSlug, route.category, route.anchor));
    }

    routeHash();
    window.addEventListener("hashchange", routeHash);
    return () => window.removeEventListener("hashchange", routeHash);
  }, [activeCategory, confirmLeaveIfDirty, pathname, router, workspaceSlug]);

  return (
    <div className="space-y-3">
      <div className="lg:hidden">
        <SelectField
          label="Settings category"
          onValueChange={(value) => {
            if (value === activeCategory) return;
            if (!confirmLeaveIfDirty()) return;
            preloadSettingsCategory(value as SettingsCategory);
            router.push(categoryHref(workspaceSlug, value as SettingsCategory));
          }}
          options={SETTINGS_CATEGORY_LINKS.map((category) => ({
            label: category.label,
            value: category.id,
          }))}
          value={activeCategory}
        />
      </div>
      <nav
        aria-label="Settings categories"
        className="sticky top-[var(--shell-scroll-padding)] hidden lg:block"
      >
        <ul className="flex flex-col gap-2">
          {SETTINGS_CATEGORY_LINKS.map((category) => {
            const isActive = category.id === activeCategory;
            return (
              <li key={category.id}>
                <Link
                  aria-current={isActive ? "page" : undefined}
                  className={`settings-anchor block ${isActive ? "settings-anchor-active" : ""}`}
                  href={categoryHref(workspaceSlug, category.id)}
                  onFocus={() => preloadSettingsCategory(category.id)}
                  onPointerEnter={() => preloadSettingsCategory(category.id)}
                >
                  <span className="block">{category.label}</span>
                  <span className="mt-0.5 block font-normal leading-4 text-muted type-annotation">
                    {category.description}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
