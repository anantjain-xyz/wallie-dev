import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";
import {
  ArtifactDecisionMockup,
  IssueInputMockup,
  PipelineBoardMockup,
  PipelineProgressMockup,
} from "@/components/landing/product-mockups";

describe("LandingPage", () => {
  it("renders exactly six sections with one h1 and sequential section headings", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html.match(/<section(?:\s|>)/g)).toHaveLength(6);
    expect(html.match(/<h1(?:\s|>)/g)).toHaveLength(1);
    expect(html.match(/<h2(?:\s|>)/g)).toHaveLength(5);
    expect(html).toContain("The Future of Software Factories is Multiplayer");
    expect(html).toContain("Bring the Linear issue into focus.");
    expect(html).toContain("See exactly which stage owns the work.");
    expect(html).toContain("Review the artifact, then approve or return it.");
    expect(html).toContain("Boundaries your team can see.");
    expect(html).toContain("Directo your team");
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
    expect(html).toContain("Create session");
    expect(html).toContain("Approve artifact");
    expect(html).toContain("Return with feedback");
  });

  it("shows a kanban-style pipeline board preview in the hero", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Pipeline board preview");
    expect(html).toContain("Plan");
    expect(html).toContain("Build");
    expect(html).toContain("Review");
    expect(html).toContain("Land");
    expect(html).toContain("Frame auth callback edge cases");
    expect(html).toContain("Wire session create from Linear");
    expect(html).toContain("Tighten RLS on artifacts");
    expect(html).toContain("Update Linear and Agent labels");
    expect(html).toContain("Cut landing page mobile noise");
    expect(html).not.toContain("Add pipeline stage reorder");
    expect(html).not.toContain("PR #191");
    expect(html).not.toContain("OP-349 ready");
  });

  it("uses a complete static three-state story without time-driven motion", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("New session · Source");
    expect(html).toContain("Session · Pipeline");
    expect(html).toContain("Build · Artifact v2");
    expect(html).not.toContain("animate-");
    expect(html).not.toContain("aria-live");
  });

  it("limits trust copy to the three approved boundaries", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Human approval gates");
    expect(html).toContain("Workspace isolation");
    expect(html).toContain("Integration boundaries");
    expect(html).not.toMatch(/customers|teams trust|work faster/i);
  });

  it("smoke-renders each focused product crop", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(PipelineBoardMockup),
        createElement(IssueInputMockup),
        createElement(PipelineProgressMockup),
        createElement(ArtifactDecisionMockup),
      ),
    );

    expect(html).toContain("Pipeline board preview");
    expect(html).toContain("OP-349");
    expect(html).toContain("Plan");
    expect(html).toContain("Build");
    expect(html).toContain("Review");
    expect(html).toContain("Land");
    expect(html).toContain("Awaiting review");
  });
});
