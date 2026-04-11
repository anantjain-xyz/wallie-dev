import { describe, expect, it } from "vitest";

import {
  buildWallieBlockingReasons,
  canRetryWallieRun,
  inferWallieRunMode,
} from "@/lib/wallie/core";

describe("wallie core helpers", () => {
  it("infers project or code mode from repository linkage", () => {
    expect(inferWallieRunMode(null)).toBe("project");
    expect(inferWallieRunMode("repo-id")).toBe("code");
  });

  it("surfaces blocking reasons and retry eligibility", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: true,
      missingSecretKeys: ["ANTHROPIC_API_KEY"],
      mode: "code",
      repository: {
        isArchived: true,
      },
    });

    expect(reasons.map((reason) => reason.code)).toEqual([
      "active_run",
      "repository_archived",
      "missing_secret",
    ]);
    expect(canRetryWallieRun("success", false)).toBe(true);
    expect(canRetryWallieRun("success", true)).toBe(false);
    expect(canRetryWallieRun("running", false)).toBe(false);
  });

  it("requires a linked repository in code mode", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: [],
      mode: "code",
      repository: null,
    });

    expect(reasons.map((reason) => reason.code)).toEqual(["repository_unavailable"]);
  });

  it("returns no blocking reasons when project mode is configured", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: [],
      mode: "project",
      repository: null,
    });

    expect(reasons).toEqual([]);
  });
});
