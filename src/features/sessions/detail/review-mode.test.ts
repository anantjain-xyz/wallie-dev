import { describe, expect, it } from "vitest";

import { resolveReviewMode } from "@/features/sessions/detail/review-mode";

describe("resolveReviewMode", () => {
  it("returns reviewable when awaiting review and authorized", () => {
    expect(
      resolveReviewMode({
        archivedAt: null,
        canReview: true,
        phaseStatus: "awaiting_review",
        selectedStageIsCurrent: true,
      }),
    ).toEqual({ kind: "reviewable" });
  });

  it("returns running while the agent is generating", () => {
    expect(
      resolveReviewMode({
        archivedAt: null,
        canReview: true,
        phaseStatus: "agent_generating",
        selectedStageIsCurrent: true,
      }),
    ).toEqual({ kind: "running" });
  });

  it("returns completed with an explicit reason", () => {
    const mode = resolveReviewMode({
      archivedAt: null,
      canReview: true,
      phaseStatus: "approved",
      selectedStageIsCurrent: true,
    });
    expect(mode.kind).toBe("completed");
    if (mode.kind === "completed") {
      expect(mode.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns failed with an explicit reason when the latest run failed", () => {
    const mode = resolveReviewMode({
      archivedAt: null,
      canReview: true,
      hasFailedRun: true,
      phaseStatus: "awaiting_review",
      selectedStageIsCurrent: true,
    });
    expect(mode.kind).toBe("failed");
    if (mode.kind === "failed") {
      expect(mode.reason).toMatch(/failed/i);
    }
  });

  it("returns archived with an explicit reason", () => {
    const mode = resolveReviewMode({
      archivedAt: "2026-07-01T00:00:00.000Z",
      canReview: true,
      phaseStatus: "awaiting_review",
      selectedStageIsCurrent: true,
    });
    expect(mode.kind).toBe("archived");
    if (mode.kind === "archived") {
      expect(mode.reason).toMatch(/archived/i);
    }
  });

  it("returns unauthorized with an explicit reason", () => {
    const mode = resolveReviewMode({
      archivedAt: null,
      canReview: false,
      phaseStatus: "awaiting_review",
      selectedStageIsCurrent: true,
    });
    expect(mode.kind).toBe("unauthorized");
    if (mode.kind === "unauthorized") {
      expect(mode.reason).toMatch(/not authorized/i);
    }
  });

  it("returns canceled when the stage is not ready for review", () => {
    const mode = resolveReviewMode({
      archivedAt: null,
      canReview: true,
      phaseStatus: "rejected",
      selectedStageIsCurrent: true,
    });
    expect(mode.kind).toBe("canceled");
    if (mode.kind === "canceled") {
      expect(mode.reason).toMatch(/not ready for review/i);
    }
  });
});
