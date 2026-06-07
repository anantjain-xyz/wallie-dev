import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandingPage } from "@/components/landing/landing-page";
import {
  ApprovalGatesMockup,
  HeroWorkspaceMockup,
  RuntimeChoiceMockup,
  SandboxExecutionMockup,
} from "@/components/landing/product-mockups";

describe("LandingPage", () => {
  it("smoke-renders the landing page and top auth form", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Wallie");
    expect(html).toContain("Bring agents together with your team in one shared workspace.");
    expect(html).toContain('action="/auth/email"');
    expect(html).toContain('name="email"');
    expect(html).toContain("Approval gates your team controls");
    expect(html).toContain("Bring your favorite agent and sandbox");
  });

  it("smoke-renders the code-native product mockups", () => {
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(HeroWorkspaceMockup),
        createElement(SandboxExecutionMockup),
        createElement(ApprovalGatesMockup),
        createElement(RuntimeChoiceMockup),
      ),
    );

    expect(html).toContain("Default pipeline");
    expect(html).toContain("vercel://acme-sso-4921");
    expect(html).toContain("Review pipeline");
    expect(html).toContain("Approvers: Ava Patel, Jordan Kim");
    expect(html).toContain("Connect Agent");
    expect(html).toContain("Provider access");
    expect(html).toContain("Vercel Sandbox");
  });
});
