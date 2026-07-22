import { describe, expect, it } from "vitest";

import {
  buildWallieBlockingReasons,
  canRetryWallieRun,
  inferWallieRunMode,
} from "@/features/wallie/utils";
import type { WallieVercelSandboxConnectionStatus } from "@/features/wallie/types";

const connectedVercel: WallieVercelSandboxConnectionStatus = {
  connected: true,
  lastValidationError: null,
  projectId: "prj_123",
  projectName: "wallie-sandboxes",
  status: "connected",
  teamId: "team_123",
};

describe("inferWallieRunMode", () => {
  it("returns code when a repository is linked", () => {
    expect(inferWallieRunMode("repo-id-123")).toBe("code");
  });

  it("returns project when no repository is linked", () => {
    expect(inferWallieRunMode(null)).toBe("project");
  });
});

describe("canRetryWallieRun", () => {
  it("allows retry for failed or canceled runs when no active run exists", () => {
    expect(canRetryWallieRun("error", false)).toBe(true);
    expect(canRetryWallieRun("canceled", false)).toBe(true);
    expect(canRetryWallieRun("success", false)).toBe(false);
  });

  it("blocks retry when an active run exists", () => {
    expect(canRetryWallieRun("error", true)).toBe(false);
  });
});

describe("buildWallieBlockingReasons", () => {
  it("blocks when missing secret keys", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: ["LINEAR_API_KEY"],
      mode: "project",
      repository: null,
      vercelSandboxConnection: connectedVercel,
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
      vercelSandboxConnection: connectedVercel,
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
      vercelSandboxConnection: connectedVercel,
    });
    expect(reasons).toHaveLength(0);
  });

  it("identifies the selected provider when its sandbox connection is missing", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: [],
      mode: "project",
      repository: null,
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: null,
        provider: "e2b",
        providerLabel: "E2B",
        projectId: null,
        projectName: null,
        status: "missing",
        teamId: null,
      },
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatchObject({
      code: "sandbox_connection_missing",
      provider: "e2b",
    });
  });

  it("does not block missing Vercel Sandbox when the selected sandbox does not require Vercel", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: [],
      mode: "project",
      repository: null,
      requiresVercelSandbox: false,
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: null,
        projectId: null,
        projectName: null,
        status: "missing",
        teamId: null,
      },
    });

    expect(reasons).toHaveLength(0);
  });

  it("blocks when Vercel Sandbox is invalid", () => {
    const reasons = buildWallieBlockingReasons({
      hasActiveRun: false,
      missingSecretKeys: [],
      mode: "project",
      repository: null,
      vercelSandboxConnection: {
        connected: false,
        lastValidationError: "Vercel rejected the token.",
        projectId: "prj_123",
        projectName: null,
        status: "error",
        teamId: "team_123",
      },
    });

    expect(reasons).toHaveLength(1);
    expect(reasons[0]!.code).toBe("sandbox_connection_invalid");
  });
});
