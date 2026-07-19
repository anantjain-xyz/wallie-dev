import type { SessionPhaseStatus } from "@/features/sessions/types";

export type ReviewMode =
  | { kind: "reviewable"; canApprove: boolean }
  | { kind: "running" }
  | { kind: "completed"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "archived"; reason: string }
  | { kind: "canceled"; reason: string }
  | { kind: "unauthorized"; reason: string }
  | { kind: "other_stage" };

export type ResolveReviewModeInput = {
  archivedAt: string | null;
  /** True when the viewer may approve the current stage. */
  canApprove: boolean;
  /**
   * True when the viewer may request changes. Server allows any workspace
   * member to reject; defaults to true for authenticated detail viewers.
   */
  canReject?: boolean;
  /** True when the current stage’s latest agent run ended in error. */
  hasFailedRun?: boolean;
  phaseStatus: SessionPhaseStatus;
  selectedStageIsCurrent: boolean;
};

/**
 * Decide what the sticky review surface should expose for the selected stage.
 * Read-only modes always carry an explicit reason — never silent disabled controls.
 */
export function resolveReviewMode(input: ResolveReviewModeInput): ReviewMode {
  const canReject = input.canReject ?? true;

  // Terminal approval archives the session; prefer the completed reason so we
  // don't tell reviewers to unarchive a finished pipeline.
  if (input.phaseStatus === "approved") {
    return {
      kind: "completed",
      reason: "This session is complete. Review controls are closed.",
    };
  }

  if (input.archivedAt) {
    return {
      kind: "archived",
      reason: "This session is archived. Unarchive it to resume review.",
    };
  }

  if (!input.selectedStageIsCurrent) {
    return { kind: "other_stage" };
  }

  if (input.hasFailedRun) {
    return {
      kind: "failed",
      reason: "The latest run failed. Review is paused until Wallie produces a new artifact.",
    };
  }

  if (input.phaseStatus === "agent_generating") {
    return { kind: "running" };
  }

  if (input.phaseStatus === "rejected") {
    return {
      kind: "canceled",
      reason:
        "This stage is not ready for review. If Wallie is retrying, wait for the next artifact; otherwise start a new run.",
    };
  }

  if (input.phaseStatus === "awaiting_review") {
    if (!canReject && !input.canApprove) {
      return {
        kind: "unauthorized",
        reason: "You are not authorized to approve or request changes on this stage.",
      };
    }

    return { kind: "reviewable", canApprove: input.canApprove };
  }

  return { kind: "other_stage" };
}
