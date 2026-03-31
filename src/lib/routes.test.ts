import { describe, expect, it } from "vitest";

import {
  loginPath,
  onboardingWorkspacePath,
  signupPath,
  workspaceIssueDetailPath,
  workspaceIssuesPath,
  workspaceLabel,
  workspaceSettingsPath,
} from "@/lib/routes";

describe("workspace route helpers", () => {
  it("builds an issue list path with query params", () => {
    expect(
      workspaceIssuesPath("northwind-labs", {
        query: "realtime",
        sort: "updated",
      }),
    ).toBe("/w/northwind-labs/issues?query=realtime&sort=updated");
  });

  it("builds detail and settings paths", () => {
    expect(workspaceIssueDetailPath("northwind-labs", 101)).toBe(
      "/w/northwind-labs/issues/101",
    );
    expect(workspaceSettingsPath("northwind-labs")).toBe(
      "/w/northwind-labs/settings",
    );
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
    expect(loginPath("/w/northwind-labs")).toBe(
      "/login?next=%2Fw%2Fnorthwind-labs",
    );
    expect(signupPath("/onboarding/workspace")).toBe(
      "/signup?next=%2Fonboarding%2Fworkspace",
    );
    expect(onboardingWorkspacePath()).toBe("/onboarding/workspace");
  });
});
