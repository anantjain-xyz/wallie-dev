import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsLoadingSkeleton } from "@/features/settings/loading-skeleton";

describe("SettingsLoadingSkeleton", () => {
  it("renders an accessible non-interactive settings fallback", () => {
    const html = renderToStaticMarkup(createElement(SettingsLoadingSkeleton));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading settings"');
    expect(html).toContain("lg:grid-cols-[180px_minmax(0,1fr)]");
    expect(html).toContain("settings-section-header");
    expect((html.match(/scroll-mt-8/g) ?? []).length).toBe(12);
    expect((html.match(/animate-pulse/g) ?? []).length).toBeGreaterThan(40);
    expect(html).not.toMatch(/<(?:a|button|input|select|textarea)\b/);
  });
});
