import { describe, expect, it, vi } from "vitest";

import {
  buildStageTimeline,
  centerStageTimelineSelection,
} from "@/features/sessions/detail/stage-timeline";
import type { SessionReviewSession } from "@/features/sessions/detail/data";

function makeSession(overrides: Partial<SessionReviewSession> = {}): SessionReviewSession {
  return {
    archivedAt: null,
    artifacts: [],
    createdAt: "2026-06-07T10:00:00.000Z",
    currentArtifactVersion: 1,
    currentStageId: "stage-2",
    currentStageSlug: "build",
    id: "session-1",
    linearIssueId: null,
    linearIssueUrl: null,
    number: 1,
    phaseCompletions: [{ completedAt: "2026-06-07T11:00:00.000Z", stageSlug: "plan" }],
    phaseStatus: "awaiting_review",
    pipeline: {
      stages: [
        { description: "Plan", id: "stage-1", name: "Plan", position: 0, slug: "plan" },
        { description: "Build", id: "stage-2", name: "Build", position: 1, slug: "build" },
        { description: "Land", id: "stage-3", name: "Land", position: 2, slug: "land" },
      ],
    },
    promptMd: "prompt",
    pullRequests: [],
    title: "Session",
    updatedAt: "2026-06-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("buildStageTimeline", () => {
  it("marks completed, current, and upcoming stages", () => {
    const timeline = buildStageTimeline(makeSession());
    expect(timeline.map((entry) => entry.status)).toEqual(["completed", "current", "upcoming"]);
  });

  it("marks changes_requested when the current stage is rejected", () => {
    const timeline = buildStageTimeline(makeSession({ phaseStatus: "rejected" }));
    expect(timeline[1]?.status).toBe("changes_requested");
  });

  it("marks failed when a failed stage slug is provided", () => {
    const timeline = buildStageTimeline(makeSession(), { failedStageSlug: "build" });
    expect(timeline[1]?.status).toBe("failed");
  });
});

describe("centerStageTimelineSelection", () => {
  it("centers the selected stage with horizontal rail scrolling only", () => {
    const scrollTo = vi.fn();
    const rail = {
      clientWidth: 320,
      scrollTo,
      scrollWidth: 900,
    } as unknown as HTMLOListElement;
    const selectedButton = {
      offsetLeft: 480,
      offsetWidth: 120,
    } as HTMLButtonElement;

    centerStageTimelineSelection(rail, selectedButton);

    expect(scrollTo).toHaveBeenCalledWith({ behavior: "auto", left: 380 });
  });
});
