import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";

describe("LandingPage", () => {
  it("offers hosted and self-hosted entry points with setup expectations", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html.match(/href="\/login"/g)).toHaveLength(1);
    expect(html).toContain("docs/SELF_HOSTING.md");
    expect(html).toContain("agent credentials");
    expect(html).toContain("Linear is optional");
  });

  it("presents an accessible example without fake interactive controls", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Example workflow");
    expect(html).toContain("<ol");
    expect(html).toContain("Review the approach before code changes");
    expect(html).toContain("merge when you");
    expect(html).not.toMatch(/<(button|input|select|textarea)(?:\s|>)/);
  });
});
