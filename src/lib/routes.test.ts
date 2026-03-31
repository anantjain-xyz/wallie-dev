import { describe, expect, it } from "vitest";

import {
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
  });

  it("formats a workspace label from the slug", () => {
    expect(workspaceLabel("northwind-labs")).toBe("Northwind Labs");
  });
});
