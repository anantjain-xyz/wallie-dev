// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StageTimeline,
  buildStageTimeline,
  centerStageTimelineSelection,
  stageTimelineLabel,
} from "@/features/sessions/detail/stage-timeline";
import type { SessionReviewSession } from "@/features/sessions/detail/data";

afterEach(cleanup);

function makeSession(overrides: Partial<SessionReviewSession> = {}): SessionReviewSession {
  return {
    archivedAt: null,
    artifacts: [],
    attachments: [],
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

  it("uses neutral wording for rejected or stopped stages", () => {
    const timeline = buildStageTimeline(makeSession({ phaseStatus: "rejected" }));
    expect(timeline[1]?.status).toBe("not_running");
  });

  it("marks failed when a failed stage slug is provided", () => {
    const timeline = buildStageTimeline(makeSession(), { failedStageSlug: "build" });
    expect(timeline[1]?.status).toBe("failed");
  });
});

it("does not infer completion for an unapproved stage moved before the current stage", () => {
  const session = makeSession();
  const [plan, build, land] = session.pipeline.stages;
  session.pipeline.stages = [plan!, land!, build!];
  const timeline = buildStageTimeline(session);
  expect(timeline.map(stageTimelineLabel)).toEqual([
    "Completed",
    "Not approved",
    "Awaiting review",
  ]);
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

describe("StageTimeline", () => {
  it("keeps stage selection wired to each stage name", () => {
    const onSelect = vi.fn();
    render(
      createElement(StageTimeline, {
        onSelect,
        selectedStageSlug: "build",
        timeline: buildStageTimeline(makeSession()),
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Land: Upcoming" }));

    expect(onSelect).toHaveBeenCalledWith("land");
  });

  it("distinguishes the stage being viewed from the current pipeline stage", () => {
    render(
      createElement(StageTimeline, {
        onSelect: vi.fn(),
        selectedStageSlug: "plan",
        timeline: buildStageTimeline(makeSession()),
      }),
    );
    const completed = screen.getByRole("button", { name: "Plan: Completed" });
    const current = screen.getByRole("button", { name: "Build: Awaiting review" });
    expect(completed.getAttribute("aria-pressed")).toBe("true");
    expect(completed.hasAttribute("aria-current")).toBe(false);
    expect(current.getAttribute("aria-current")).toBe("step");
    expect(current.getAttribute("aria-pressed")).toBe("false");
  });

  it("shows failure and stopped states as text as well as visual indicators", () => {
    expect(
      stageTimelineLabel(buildStageTimeline(makeSession(), { failedStageSlug: "build" })[1]!),
    ).toBe("Failed");
    expect(
      stageTimelineLabel(buildStageTimeline(makeSession({ phaseStatus: "rejected" }))[1]!),
    ).toBe("Not running");
    expect(
      stageTimelineLabel(buildStageTimeline(makeSession({ phaseStatus: "in_progress" }))[1]!),
    ).toBe("In progress");
  });

  it("marks a terminal approved stage completed before its completion event arrives", () => {
    const timeline = buildStageTimeline(
      makeSession({ currentStageSlug: "land", phaseStatus: "approved" }),
    );
    expect(timeline.map(stageTimelineLabel)).toEqual(["Completed", "Not approved", "Completed"]);
  });

  it("does not mark an earlier failed stage as the current step", () => {
    const html = renderToStaticMarkup(
      createElement(StageTimeline, {
        onSelect: vi.fn(),
        selectedStageSlug: "plan",
        timeline: buildStageTimeline(makeSession(), { failedStageSlug: "plan" }),
      }),
    );
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  });

  it("contains long unbroken stage names at narrow widths", () => {
    const session = makeSession({
      pipeline: {
        stages: [
          {
            description: "Custom stage",
            id: "stage-2",
            name: "ImplementationReviewWithAnExtremelyLongUnbrokenName",
            position: 0,
            slug: "build",
          },
        ],
      },
    });
    const html = renderToStaticMarkup(
      createElement(StageTimeline, {
        onSelect: vi.fn(),
        selectedStageSlug: "build",
        timeline: buildStageTimeline(session),
      }),
    );

    expect(html).toContain("min-w-0 max-w-full");
    expect(html).toContain("[overflow-wrap:anywhere]");
  });
});
