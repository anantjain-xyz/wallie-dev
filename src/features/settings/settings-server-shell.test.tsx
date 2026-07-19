import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/settings/settings-category-nav", () => ({
  SettingsCategoryNav: () => null,
}));
vi.mock("@/features/settings/islands/integration-islands", () => ({
  GithubIntegrationIsland: () => null,
  LinearIntegrationIsland: () => null,
  ProviderIntentLink: () => null,
  RepositoryIntegrationIsland: () => null,
  RuntimeIntegrationIsland: () => null,
  VercelIntegrationIsland: () => null,
}));

import {
  DEFAULT_SETTINGS_CATEGORY,
  parseSettingsCategory,
} from "@/features/settings/settings-categories";
import {
  SettingsServerShell,
  SettingsSectionError,
  SettingsSectionFallback,
} from "@/features/settings/settings-server-shell";

describe("Settings server shell", () => {
  it("selects exactly one supported category and falls back safely", () => {
    expect(parseSettingsCategory("pipeline")).toBe("pipeline");
    expect(parseSettingsCategory(["workspace", "advanced"])).toBe("workspace");
    expect(parseSettingsCategory("unknown")).toBe(DEFAULT_SETTINGS_CATEGORY);
    expect(parseSettingsCategory(undefined)).toBe(DEFAULT_SETTINGS_CATEGORY);
  });

  it("uses geometry-stable section loading and error states", () => {
    const loading = renderToStaticMarkup(
      createElement(SettingsSectionFallback, { label: "usage", minHeight: "min-h-72" }),
    );
    const error = renderToStaticMarkup(
      createElement(SettingsSectionError, { label: "Usage", minHeight: "min-h-72" }),
    );

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("min-h-72");
    expect(error).toContain('role="alert"');
    expect(error).toContain("min-h-72");
  });

  it("leaves the page-level main landmark to the authenticated app shell", () => {
    const pending = new Promise<never>(() => undefined);
    const html = renderToStaticMarkup(
      createElement(SettingsServerShell, {
        category: "integrations",
        initialData: {
          canManage: false,
          github: null,
          workspace: { id: "workspace-1", slug: "acme-corp" },
        } as never,
        searchState: { codexStatus: null, githubStatus: null },
        setupData: pending,
        usage: pending,
        workspaceInvitations: pending,
      }),
    );

    expect(html).not.toContain("<main");
    expect(html).toContain('class="min-h-full"');
  });
});
