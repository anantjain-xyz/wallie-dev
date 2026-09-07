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

  it("separates provider choices from the workflow without demo controls", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<figure(?:\s|>)/g)).toHaveLength(2);
    expect(html).toContain("Choose your coding agent");
    expect(html).toContain("Choose your sandbox");
    expect(html).toContain("Design your workflow");
    expect(html).toContain("<ol");
    expect(html).toContain("wait for your approval");
    expect(html).not.toContain("Add dark mode");
    expect(html).not.toMatch(/<(button|input|select|textarea)(?:\s|>)/);
  });
});
