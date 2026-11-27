import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";

describe("LandingPage", () => {
  it("offers hosted and self-hosted entry points with setup expectations", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain("Self-improving software factory</h1>");
    expect(html).toContain('href="/login"');
    expect(html).toContain("Try hosted Wallie");
    expect(html).not.toContain("Get started");
    expect(html).toContain("docs/deployment/self-hosting.md");
    expect(html).toContain("For a hosted workspace");
    expect(html).toContain("agent credentials");
    expect(html).toContain("Linear is optional");
  });

  it("server-renders the fictional tour and its configured path without an embedded demo", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("A fictional job.");
    expect(html).toContain("Open the definition sheet");
    expect(html).toContain("Send to Plan");
    expect(html).toContain("Run configuration test");
    expect(html).toContain("Configured path · rollout varies");
    expect(html).toContain("It isn’t a fresh-workspace default.");
    expect(html.indexOf('id="studio"')).toBeLessThan(html.indexOf('id="line"'));
    expect(html.indexOf('id="line"')).toBeLessThan(html.indexOf('id="improve"'));
    expect(html).not.toMatch(/<(iframe|script|form|input|select|textarea)(?:\s|>)/);
  });
});
