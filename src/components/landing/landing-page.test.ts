import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";

describe("LandingPage", () => {
  it("offers hosted and self-hosted entry points with setup expectations", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html.match(/href="\/login"/g)).toHaveLength(2);
    expect(html).toContain("docs/deployment/self-hosting.md");
    expect(html).toContain("Sign in by email, then set up your workspace.");
    expect(html).toContain("agent credentials");
    expect(html).toContain("Linear is optional");
  });

  it("server-renders the complete workflow before static provider lists", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<figure(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain("Example workflow");
    expect(html).toContain("Supported coding agents");
    expect(html).toContain("Supported sandboxes");
    expect(html.indexOf("Example workflow")).toBeLessThan(html.indexOf("Supported coding agents"));
    expect(html).toContain("<ol");
    expect(html).toContain("Wallie starts the build after you approve the plan.");
    expect(html).not.toContain("Add stage");
    expect(html).not.toContain("Add dark mode");
    expect(html).not.toMatch(/<(button|input|select|textarea)(?:\s|>)/);
  });
});
