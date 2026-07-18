import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PipelineLoadingSkeleton } from "@/features/pipeline/loading-skeleton";

describe("PipelineLoadingSkeleton", () => {
  it("renders an accessible non-interactive pipeline fallback", () => {
    const html = renderToStaticMarkup(createElement(PipelineLoadingSkeleton));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading pipeline"');
    expect(html).toContain("min-h-full bg-canvas");
    expect(html).toContain("md:w-[260px]");
    expect((html.match(/<article/g) ?? []).length).toBe(4);
    expect((html.match(/animate-pulse/g) ?? []).length).toBeLessThan(40);
    expect(html).not.toMatch(/<(?:a|button|input|select|textarea)\b/);
  });
});
