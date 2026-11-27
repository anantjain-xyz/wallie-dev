import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";

describe("LandingPage", () => {
  it("offers hosted and self-hosted entry points with setup expectations", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain("Self-improving software factory</h1>");
    expect(html).toContain("Make your own software factory</h2>");
    expect(html).toContain('href="/login"');
    expect(html).toContain("Try hosted Wallie");
    expect(html).not.toContain("Get started");
    expect(html).toContain("docs/deployment/self-hosting.md");
    expect(html).toContain("For a hosted workspace");
    expect(html).toContain("agent credentials");
    expect(html).toContain("Linear is optional");
    expect(html).not.toMatch(/All work orders and results are fictional|Destinations: Wallie/);
  });

  it("server-renders the fictional tour and its configured path without an embedded demo", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Set up your factory. Let agents run tasks through human review.");
    expect(html).toContain("Read the setup receipt");
    expect(html).toContain("Send to Plan");
    expect(html).toContain(
      "The review note on 024 is a lead, not a failed check or scorer result.",
    );
    expect(html).toContain("Example comparison / Before adoption");
    expect(html).toContain("Two illustrative rows don’t qualify a revision.");
    expect(html).toContain("Not a default:");
    expect(html).toContain("Without benchmark setup");
    expect(
      Array.from(html.matchAll(/<section[^>]+id="(configure|run|improve)"/g), ([, id]) => id),
    ).toEqual(["configure", "run", "improve"]);
    const workOrder = html.indexOf('id="order-title"');
    expect(workOrder).toBeGreaterThan(html.indexOf('id="run"'));
    expect(workOrder).toBeLessThan(html.indexOf('id="improve"'));
    expect(html).not.toMatch(/<(iframe|script|form|input|select|textarea)(?:\s|>)/);
  });
});
