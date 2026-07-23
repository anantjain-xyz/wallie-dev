import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";
import {
  ExpertApprovalMockup,
  PipelineBoardMockup,
  StackWorkflowMockup,
  ValidationProofMockup,
} from "@/components/landing/product-mockups";

describe("LandingPage", () => {
  it("renders exactly five sections with one h1 and a focused product narrative", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<section(?:\s|>)/g)).toHaveLength(5);
    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html.match(/<h2(?:\s|>)/g)).toHaveLength(4);
    expect(html).toContain("The Future of Software Factories is Multiplayer");
    expect(html).toContain("Bring your agents. Design your workflow.");
    expect(html).toContain("Let the right experts move work forward.");
    expect(html).toContain("Bring review-ready PRs, with the proof attached.");
    expect(html).toContain("Direct your team");
    expect(html).not.toContain("Human control, kept explicit");
    expect(html).not.toContain("Keep the next handoff reviewable");
  });

  it("uses the required CTA destinations and a focusable walkthrough target", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain('href="/login"');
    expect(html).toContain("Sign in to Wallie");
    expect(html).toContain('href="#product-walkthrough"');
    expect(html).toContain('id="product-walkthrough"');
    expect(html).toContain('tabindex="-1"');
  });

  it("keeps decorative product controls out of the interactive accessibility tree", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).not.toMatch(/<(button|input|select|textarea)(?:\s|>)/);
    expect(html.match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain("Use subscription");
    expect(html).toContain("Engineer approved Plan");
    expect(html).toContain("Ready to review");
  });

  it("shows a multiplayer pipeline board with complete task and approval states", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Multiplayer pipeline board");
    expect(html).toContain("Plan");
    expect(html).toContain("Build");
    expect(html).toContain("Review");
    expect(html).toContain("Land");
    expect(html).toContain("Task 1");
    expect(html).toContain("Task 6");
    expect(html).toContain("Agent working");
    expect(html).toContain("Ready for approval");
    expect(html).toContain("Approved");
    expect(html).not.toContain("line-clamp");
  });

  it("uses the supported providers and labels future agent options honestly", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Codex");
    expect(html).toContain("Claude Code");
    expect(html).toContain("Cursor");
    expect(html).toContain("Coming soon");
    expect(html).toContain("Vercel");
    expect(html).toContain("E2B");
    expect(html).toContain("Daytona");
    expect(html).toContain("Open source · MIT licensed");
    expect(html).toContain("Linear issue source");
  });

  it("uses CSS-only pipeline motion with complete static content", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Session · Approval routing");
    expect(html).toContain("landing-flow-task");
    expect(html).toContain("Engineer approved Plan");
    expect(html).toContain("Designer approved UI");
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain("<script");
  });

  it("smoke-renders each focused product crop", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(PipelineBoardMockup),
        createElement(StackWorkflowMockup),
        createElement(ExpertApprovalMockup),
        createElement(ValidationProofMockup),
      ),
    );

    expect(html).toContain("Multiplayer pipeline board");
    expect(html).toContain("Your stack · Your workflow");
    expect(html).toContain("TASK 2");
    expect(html).toContain("PR #184");
    expect(html).toContain("Plan");
    expect(html).toContain("Build");
    expect(html).toContain("Review");
    expect(html).toContain("Land");
    expect(html).toContain("All checks passed");
  });
});
