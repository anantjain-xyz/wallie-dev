import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CompletionMark } from "@/features/onboarding/completion-mark";

describe("CompletionMark", () => {
  it("exposes an accessible Done name without a Status pill", () => {
    const html = renderToStaticMarkup(createElement(CompletionMark));

    expect(html).toContain('class="sr-only">Done</span>');
    expect(html).toContain("text-success");
    expect(html).toContain("h-3.5 w-3.5");
    expect(html).not.toContain("data-status");
    expect(html).not.toContain("data-tone");
  });
});
