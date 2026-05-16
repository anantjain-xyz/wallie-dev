import { describe, expect, it } from "vitest";

import {
  loginPath,
  onboardingWorkspacePath,
  signupPath,
  workspaceBasePath,
  workspaceLabel,
  workspaceOnboardingPath,
  workspaceSessionDetailPath,
  workspaceSessionsPath,
  workspaceSettingsPath,
} from "@/lib/routes";

describe("workspace route helpers", () => {
  it("builds the workspace home path (pipeline board)", () => {
    expect(workspaceBasePath("northwind-labs")).toBe("/w/northwind-labs");
  });

  it("builds a sessions list path with query params", () => {
    expect(
      workspaceSessionsPath("northwind-labs", {
        phase: "product",
        q: "realtime",
      }),
    ).toBe("/w/northwind-labs/sessions?phase=product&q=realtime");
  });

  it("builds detail and settings paths", () => {
    expect(workspaceSessionDetailPath("northwind-labs", 101)).toBe(
      "/w/northwind-labs/sessions/101",
    );
    expect(workspaceOnboardingPath("northwind-labs")).toBe("/w/northwind-labs/onboarding");
    expect(workspaceSettingsPath("northwind-labs")).toBe("/w/northwind-labs/settings");
    expect(
      workspaceSettingsPath("northwind-labs", {
        github: "connected",
      }),
    ).toBe("/w/northwind-labs/settings?github=connected");
  });

  it("formats a workspace label from the slug", () => {
    expect(workspaceLabel("northwind-labs")).toBe("Northwind Labs");
  });

  it("builds auth and onboarding paths", () => {
    expect(loginPath("/w/northwind-labs")).toBe("/login?next=%2Fw%2Fnorthwind-labs");
    expect(signupPath("/onboarding/workspace")).toBe("/signup?next=%2Fonboarding%2Fworkspace");
    expect(onboardingWorkspacePath()).toBe("/onboarding/workspace");
  });
});
