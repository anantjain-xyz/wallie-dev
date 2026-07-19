import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PipelineLoadingSkeleton } from "@/features/pipeline/loading-skeleton";

describe("PipelineLoadingSkeleton", () => {
  it("renders an accessible non-interactive pipeline fallback matching adaptive lanes", () => {
    const html = renderToStaticMarkup(createElement(PipelineLoadingSkeleton));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Loading pipeline"');
    expect(html).toContain(
      "min-h-[calc(100svh-3.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] bg-canvas",
    );
    expect(html).toContain("minmax(280px,1fr)");
    expect(html).toContain("--pipeline-stage-count");
    expect(html).toContain("overflow-auto");
    expect((html.match(/<article/g) ?? []).length).toBe(3);
    expect((html.match(/animate-pulse/g) ?? []).length).toBeLessThan(40);
    expect(html).not.toMatch(/<(?:a|button|input|select|textarea)\b/);
  });

  it("scales lane geometry to the requested stage count", () => {
    const html = renderToStaticMarkup(createElement(PipelineLoadingSkeleton, { stageCount: 7 }));
    expect(html).toContain("--pipeline-stage-count:7");
    expect((html.match(/<article/g) ?? []).length).toBe(7);
    expect(html).toContain("hidden md:flex");
    expect((html.match(/hidden md:flex/g) ?? []).length).toBe(6);
  });
});
