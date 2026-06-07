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

  it("renders GitHub links in the header and footer", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain('href="https://github.com/anantjain-xyz/wallie-dev"');
    expect(html).toContain("GitHub");
  });

  it("offers a Get started link to /login for narrow viewports", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain('href="/login"');
    expect(html).toContain("Get started");
  });

  it("renders the footer with author attribution", () => {
    const html = renderToStaticMarkup(createElement(LandingPage));

    expect(html).toContain("Built by");
    expect(html).toContain('href="https://anantjain.xyz"');
    expect(html).toContain("Anant Jain");
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
