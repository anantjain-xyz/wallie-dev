import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SkeletonBlock } from "@/components/ui/skeleton";
import {
  SessionDetailLoadingSkeleton,
  SessionsListLoadingSkeleton,
} from "@/features/sessions/loading-skeletons";

function expectNoFocusableFakeControls(html: string) {
  expect(html).not.toMatch(/<(?:a|button|input|select|textarea)\b/);
}

describe("SkeletonBlock", () => {
  it("renders a decorative themed pulse block", () => {
    const html = renderToStaticMarkup(
      createElement(SkeletonBlock, {
        className: "h-4 w-20",
      }),
    );

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("animate-pulse");
    expect(html).toContain("bg-control-muted");
    expect(html).toContain("h-4");
    expect(html).toContain("w-20");
  });
});

describe("SessionsListLoadingSkeleton", () => {
  it("renders an accessible non-interactive sessions list fallback", () => {
    const html = renderToStaticMarkup(createElement(SessionsListLoadingSkeleton));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading sessions"');
    expect(html).toContain("divide-y divide-border");
    expect((html.match(/animate-pulse/g) ?? []).length).toBeGreaterThan(20);
    expectNoFocusableFakeControls(html);
  });
});

describe("SessionDetailLoadingSkeleton", () => {
  it("renders an accessible non-interactive session detail fallback", () => {
    const html = renderToStaticMarkup(createElement(SessionDetailLoadingSkeleton));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading session"');
    expect(html).toContain("border-b border-border");
    expect(html).toContain("bg-control-muted");
    expect((html.match(/ui-sheet/g) ?? []).length).toBe(4);
    expectNoFocusableFakeControls(html);
  });
});
