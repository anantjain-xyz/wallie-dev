import { describe, expect, it } from "vitest";

import {
  buildWallieBillingState,
  buildWallieBlockingReasons,
  canRetryWallieRun,
  inferWallieRunMode,
  shouldResetFreeTierBillingCycle,
} from "@/lib/wallie/core";

describe("wallie core helpers", () => {
  it("infers project or code mode from repository linkage", () => {
    expect(inferWallieRunMode(null)).toBe("project");
    expect(inferWallieRunMode("repo-id")).toBe("code");
  });

  it("builds free-tier billing state and reset checks", () => {
    const billing = buildWallieBillingState({
      currentBillingCycleStartAt: "2026-03-01T00:00:00.000Z",
      successfulRunsThisCycle: 25,
      tier: "free",
    });

    expect(billing.limitReached).toBe(true);
    expect(billing.runLimit).toBe(25);
    expect(billing.runsRemaining).toBe(0);
    expect(
      shouldResetFreeTierBillingCycle(
        "2026-01-01T00:00:00.000Z",
        new Date("2026-03-31T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("surfaces blocking reasons and retry eligibility", () => {
    const billing = buildWallieBillingState({
      currentBillingCycleStartAt: "2026-03-01T00:00:00.000Z",
      successfulRunsThisCycle: 3,
      tier: "free",
    });
    const reasons = buildWallieBlockingReasons({
      billing,
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
});
