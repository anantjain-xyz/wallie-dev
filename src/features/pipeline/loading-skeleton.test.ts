import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PipelineLoadingSkeleton } from "@/features/pipeline/loading-skeleton";

describe("PipelineLoadingSkeleton", () => {
  it("renders an accessible non-interactive pipeline fallback", () => {
    const html = renderToStaticMarkup(createElement(PipelineLoadingSkeleton));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading pipeline"');
    expect(html).toContain("min-h-full bg-surface");
    expect(html).toContain("md:w-[260px]");
    expect((html.match(/animate-pulse/g) ?? []).length).toBeGreaterThan(20);
    expect(html).not.toMatch(/<(?:a|button|input|select|textarea)\b/);
  });
});
