import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";
import { StackWorkflowMockup } from "@/components/landing/product-mockups";

describe("LandingPage", () => {
  it("renders a single-viewport page with one hero section and one h1", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<section(?:\s|>)/g)).toHaveLength(1);
    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html).not.toMatch(/<h2(?:\s|>)/);
    expect(html).toContain("data-wallie-mark");
    expect(html).toContain("Run coding agents through your team");
    expect(html).toContain("isolated sandboxes");
  });

  it("links each destination exactly once", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/href="\/login"/g)).toHaveLength(1);
    expect(html).toContain("Sign in to Wallie");
    expect(html.match(/github\.com\/anantjain-xyz\/wallie-dev"/g)).toHaveLength(1);
    expect(html.match(/blob\/main\/LICENSE/g)).toHaveLength(1);
    expect(html.match(/#readme/g)).toHaveLength(1);
    expect(html.match(/MIT/g)).toHaveLength(1);
  });

  it("keeps the decorative mockup out of the interactive accessibility tree", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).not.toMatch(/<(button|input|select|textarea)(?:\s|>)/);
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows the supported providers without status chatter", () => {
    const html = renderToStaticMarkup(createElement(StackWorkflowMockup));

    expect(html).toContain("Codex");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Cursor");
    expect(html).toContain("OpenCode");
    expect(html).toContain("Vercel");
    expect(html).toContain("E2B");
    expect(html).toContain("Daytona");
    expect(html).toContain("Issues synced from Linear");
    expect(html).not.toContain("Coming soon");
    expect(html).not.toContain("approves");
  });

  it("shows the pipeline stages in the mockup", () => {
    const html = renderToStaticMarkup(createElement(StackWorkflowMockup));

    expect(html).toContain("Plan");
    expect(html).toContain("Design");
    expect(html).toContain("Build");
    expect(html).toContain("Land");
    expect(html).not.toContain("<script");
  });

  it("uses OpenCode's official rectangular O mark in the mockup", () => {
    const html = renderToStaticMarkup(createElement(StackWorkflowMockup));

    expect(html).toContain('viewBox="0 0 240 300"');
    expect(html).toContain("M180 60H60V240H180V60ZM240 300H0V0H240V300Z");
    expect(html).not.toContain("M5 4.5h14v15H5z");
  });

  it("sizes agent, sandbox, and pipeline tiles on the same grid", () => {
    const html = renderToStaticMarkup(createElement(StackWorkflowMockup));
    const gridClass = "grid grid-cols-2 gap-2 sm:grid-cols-4";

    expect(html.split(gridClass).length - 1).toBe(3);
    expect(html).not.toContain("grid-cols-3");
    expect(html).not.toContain("flex-1 rounded-[5px]");
  });
});
