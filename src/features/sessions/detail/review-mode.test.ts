import { describe, expect, it } from "vitest";

import { resolveReviewMode } from "@/features/sessions/detail/review-mode";

describe("resolveReviewMode", () => {
  it("returns reviewable when awaiting review and authorized to approve", () => {
    expect(
      resolveReviewMode({
        archivedAt: null,
        canApprove: true,
        phaseStatus: "awaiting_review",
        selectedStageIsCurrent: true,
      }),
    ).toEqual({ canApprove: true, kind: "reviewable" });
  });

  it("keeps request-changes available when the viewer cannot approve", () => {
    expect(
      resolveReviewMode({
        archivedAt: null,
        canApprove: false,
        canReject: true,
        phaseStatus: "awaiting_review",
        selectedStageIsCurrent: true,
      }),
    ).toEqual({ canApprove: false, kind: "reviewable" });
  });

  it("returns running while the agent is generating", () => {
    expect(
      resolveReviewMode({
        archivedAt: null,
        canApprove: true,
        phaseStatus: "agent_generating",
        selectedStageIsCurrent: true,
      }),
    ).toEqual({ kind: "running" });
  });

  it("returns completed with an explicit reason even when archived", () => {
    const mode = resolveReviewMode({
      archivedAt: "2026-07-01T00:00:00.000Z",
      canApprove: true,
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
      canApprove: true,
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
      canApprove: true,
      phaseStatus: "awaiting_review",
      selectedStageIsCurrent: true,
    });
    expect(mode.kind).toBe("archived");
    if (mode.kind === "archived") {
      expect(mode.reason).toMatch(/archived/i);
    }
  });

  it("returns unauthorized when neither approve nor reject is allowed", () => {
    const mode = resolveReviewMode({
      archivedAt: null,
      canApprove: false,
      canReject: false,
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
      canApprove: true,
      phaseStatus: "rejected",
      selectedStageIsCurrent: true,
    });
    expect(mode.kind).toBe("canceled");
    if (mode.kind === "canceled") {
      expect(mode.reason).toMatch(/not ready for review/i);
    }
  });
});
