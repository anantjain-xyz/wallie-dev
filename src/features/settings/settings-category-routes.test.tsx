import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  SettingsInitialData,
  SettingsSetupData,
  WorkspaceUsageData,
} from "@/features/settings/data";
import {
  SETTINGS_CATEGORIES,
  settingsCategoryMeta,
  type SettingsCategory,
} from "@/features/settings/settings-categories";
import {
  SettingsSectionError,
  SettingsSectionFallback,
  SettingsServerShell,
} from "@/features/settings/settings-server-shell";
import type { WorkspaceInvitation } from "@/lib/workspace-invitations/contracts";

vi.mock("@/features/settings/settings-category-nav", () => ({
  SettingsCategoryNav: ({ activeCategory }: { activeCategory: SettingsCategory }) =>
    createElement("nav", { "aria-label": "Settings categories" }, activeCategory),
}));

vi.mock("@/features/settings/settings-dirty-registry", () => ({
  SettingsDirtyRegistryProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/features/settings/islands/integration-islands", () => ({
  GithubIntegrationIsland: () => createElement("div", null, "github-island"),
  LinearIntegrationIsland: () => createElement("div", null, "linear-island"),
  RepositoryIntegrationIsland: () => createElement("div", null, "repository-island"),
  RuntimeIntegrationIsland: () => createElement("div", null, "runtime-island"),
  VercelIntegrationIsland: () => createElement("div", null, "vercel-island"),
}));

vi.mock("@/features/settings/islands/pipeline-island", () => ({
  PipelineIsland: () => createElement("div", null, "pipeline-island"),
}));

vi.mock("@/features/settings/islands/advanced-islands", () => ({
  MaintenanceIsland: () => createElement("div", null, "maintenance-island"),
  VerifySetupIsland: () => createElement("div", null, "verify-island"),
}));

vi.mock("@/features/settings/islands/workspace-islands", () => ({
  DangerActionsIsland: () => createElement("div", null, "danger-island"),
  WorkspaceIdentityIsland: () => createElement("div", null, "identity-island"),
  WorkspaceMembersIsland: () => createElement("div", null, "members-island"),
}));

const initialData = {
  canManage: true,
  currentMember: { id: "member-1", role: "owner" as const },
  github: {
    installation: null,
    missingAppKeys: [],
    missingWebhookKeys: [],
    primaryProfile: null,
    repositories: [],
  },
  workspace: {
    avatarPath: null,
    avatarUrl: null,
    id: "workspace-1",
    name: "Northwind",
    slug: "northwind",
  },
} satisfies SettingsInitialData;

function neverPromise<T>() {
  return new Promise<T>(() => undefined);
}

function renderCategory(category: SettingsCategory, canManage = true) {
  return renderToStaticMarkup(
    createElement(SettingsServerShell, {
      category,
      initialData: { ...initialData, canManage },
      searchState: { codexStatus: null, githubStatus: null },
      setupData: neverPromise<SettingsSetupData>(),
      usage: neverPromise<WorkspaceUsageData>(),
      workspaceInvitations: neverPromise<WorkspaceInvitation[]>(),
    }),
  );
}

describe("Settings category mounting", () => {
  it.each(SETTINGS_CATEGORIES)(
    "mounts only %s category chrome with loading and error primitives available",
    (category) => {
      const markup = renderCategory(category);

      expect(markup).toContain(`>${settingsCategoryMeta(category).label}<`);
      expect(markup).toContain('aria-label="Settings categories"');
      expect(markup).toContain(category);

      const loading = renderToStaticMarkup(
        createElement(SettingsSectionFallback, { label: `${category} section` }),
      );
      const error = renderToStaticMarkup(
        createElement(SettingsSectionError, { label: `${category} section` }),
      );
      expect(loading).toContain('aria-busy="true"');
      expect(error).toContain('role="alert"');
    },
  );

  it("keeps Danger Zone on Advanced and identity on General", () => {
    const advanced = renderCategory("advanced");
    expect(advanced).toContain("danger-island");
    expect(advanced).not.toContain("identity-island");

    const general = renderCategory("general");
    expect(general).toContain("identity-island");
    expect(general).not.toContain("danger-island");
  });

  it("explains required access for read-only viewers", () => {
    const markup = renderCategory("pipeline", false);
    expect(markup).toContain("Workspace admins and owners can change these settings");
  });
});
