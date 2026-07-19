import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS_CATEGORY,
  parseSettingsCategory,
  SETTINGS_CATEGORIES,
  settingsCategoryMeta,
} from "@/features/settings/settings-categories";
import {
  SettingsSectionError,
  SettingsSectionFallback,
} from "@/features/settings/settings-server-shell";

describe("Settings categories", () => {
  it("selects exactly one supported category and falls back safely", () => {
    expect(parseSettingsCategory("pipeline")).toBe("pipeline");
    expect(parseSettingsCategory(["members", "advanced"])).toBe("members");
    expect(parseSettingsCategory("workspace")).toBe("general");
    expect(parseSettingsCategory("unknown")).toBe(DEFAULT_SETTINGS_CATEGORY);
    expect(parseSettingsCategory(undefined)).toBe(DEFAULT_SETTINGS_CATEGORY);
    expect(DEFAULT_SETTINGS_CATEGORY).toBe("general");
    expect(SETTINGS_CATEGORIES).toEqual([
      "general",
      "integrations",
      "agent-execution",
      "pipeline",
      "members",
      "advanced",
    ]);
  });

  it("exposes one purpose and document title per category", () => {
    for (const category of SETTINGS_CATEGORIES) {
      const meta = settingsCategoryMeta(category);
      expect(meta.purpose.length).toBeGreaterThan(10);
      expect(meta.documentTitle.length).toBeGreaterThan(3);
      expect(meta.id).toBe(category);
    }
  });
});

describe("Settings server shell", () => {
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
});
