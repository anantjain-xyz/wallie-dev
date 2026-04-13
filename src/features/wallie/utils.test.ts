import { describe, expect, it } from "vitest";

import {
  buildWallieBlockingReasons,
  canRetryWallieRun,
  inferWallieRunMode,
} from "@/features/wallie/utils";

describe("inferWallieRunMode", () => {
  it("returns code when a repository is linked", () => {
    expect(inferWallieRunMode("repo-id-123")).toBe("code");
  });

  it("returns project when no repository is linked", () => {
    expect(inferWallieRunMode(null)).toBe("project");
  });
});

describe("canRetryWallieRun", () => {
  it("allows retry when run is terminal and no active run exists", () => {
    expect(canRetryWallieRun("error", false)).toBe(true);
    expect(canRetryWallieRun("success", false)).toBe(true);
  });

  it("blocks retry when an active run exists", () => {
    expect(canRetryWallieRun("error", true)).toBe(false);
  });
});

describe("buildWallieBlockingReasons", () => {
  it("blocks when missing secret keys", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: ["ANTHROPIC_API_KEY"],
      mode: "project",
      repository: null,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.code).toBe("missing_secret");
  });

  it("blocks code mode without a repository", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: [],
      mode: "code",
      repository: null,
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.code).toBe("repository_unavailable");
  });

  it("no reasons when project mode is configured", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: [],
      mode: "project",
      repository: null,
    });
    expect(reasons).toHaveLength(0);
  });
});
