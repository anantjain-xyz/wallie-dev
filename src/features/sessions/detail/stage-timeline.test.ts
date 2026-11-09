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
import type { StageExecution } from "./stage-execution";

const execution: StageExecution = {
  id: "run-1",
  stageId: "stage-2",
  status: "queued",
  createdAt: "2026-06-07T12:01:00.000Z",
  updatedAt: "2026-06-07T12:01:00.000Z",
};

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
  it("ignores a historical failure while the session is starting a newer execution", () => {
    const timeline = buildStageTimeline(
      makeSession({ phaseStatus: "in_progress", updatedAt: "2026-06-07T12:02:00Z" }),
      {
        currentRun: { ...execution, status: "error" },
        failedStageSlug: "build",
      },
    );
    expect(timeline[1]?.status).toBe("current");
  });

  it.each([
    ["queued", "Queued"],
    ["started", "Starting"],
    ["running", "In progress"],
  ] as const)("keeps the displayed ordinal for %s custom-stage reruns", (status, label) => {
    const session = makeSession({ phaseStatus: "rejected" });
    session.pipeline.stages[1] = {
      ...session.pipeline.stages[1]!,
      name: "Custom review",
      slug: "custom-review",
      position: 40,
    };
    render(
      createElement(StageTimeline, {
        onSelect: vi.fn(),
        selectedStageSlug: "custom-review",
        timeline: buildStageTimeline(session, {
          failedStageSlug: "custom-review",
          currentRun: { ...execution, status },
        }),
      }),
    );
    const button = screen.getByRole("button", { name: `Custom review: ${label}` });
    const marker = button.querySelector('[aria-hidden="true"]');
    expect(marker?.textContent).toBe("2");
    expect(marker?.className).not.toMatch(/warning|danger/);
    expect(button.getAttribute("aria-current")).toBe("step");
  });

  it.each([
    ["error", "Failed"],
    ["canceled", "Not running"],
  ] as const)("preserves the confirmed %s indicator", (status, label) => {
    const timeline = buildStageTimeline(makeSession({ phaseStatus: "rejected" }), {
      currentRun: { ...execution, status },
    });
    render(
      createElement(StageTimeline, { onSelect: vi.fn(), selectedStageSlug: "build", timeline }),
    );
    expect(
      screen.getByRole("button", { name: `Build: ${label}` }).querySelector('[aria-hidden="true"]')
        ?.textContent,
    ).toBe("!");
  });

  it("ignores active runs for another stage and keeps review and completion authoritative", () => {
    expect(
      buildStageTimeline(makeSession({ phaseStatus: "rejected" }), {
        currentRun: { ...execution, stageId: "stage-1" },
      })[1]?.status,
    ).toBe("waiting");
    expect(
      buildStageTimeline(makeSession(), {
        currentRun: execution,
        failedStageSlug: "build",
      })[1]?.status,
    ).toBe("current");
    expect(
      buildStageTimeline(makeSession({ phaseStatus: "approved" }), {
        currentRun: execution,
      })[1]?.status,
    ).toBe("completed");
    expect(
      buildStageTimeline(
        makeSession({ phaseStatus: "rejected", archivedAt: execution.createdAt }),
        {
          currentRun: execution,
        },
      )[1]?.status,
    ).toBe("not_running");
  });

  it("keeps the numbered marker for a queued rerun before the rejected phase updates", () => {
    const options = {
      failedStageSlug: "build",
      currentRun: {
        id: "rerun",
        stageId: "stage-2",
        status: "queued" as const,
        createdAt: "2026-06-07T12:01:00.000Z",
        updatedAt: "2026-06-07T12:01:00.000Z",
      },
    };
    const timeline = buildStageTimeline(makeSession({ phaseStatus: "rejected" }), options);
    render(
      createElement(StageTimeline, { onSelect: vi.fn(), selectedStageSlug: "build", timeline }),
    );
    const current = screen.getByRole("button", { name: "Build: Queued" });
    expect(current.querySelector('[aria-hidden="true"]')?.textContent).toBe("2");
    expect(current.getAttribute("aria-current")).toBe("step");
  });

  it("marks completed, current, and upcoming stages", () => {
    const timeline = buildStageTimeline(makeSession());
    expect(timeline.map((entry) => entry.status)).toEqual(["completed", "current", "upcoming"]);
  });

  it("keeps rejected stages neutral until execution is known", () => {
    const timeline = buildStageTimeline(makeSession({ phaseStatus: "rejected" }));
    expect(timeline[1]?.status).toBe("waiting");
    render(
      createElement(StageTimeline, { onSelect: vi.fn(), selectedStageSlug: "build", timeline }),
    );
    expect(
      screen
        .getByRole("button", { name: "Build: Waiting for run" })
        .querySelector('[aria-hidden="true"]')?.textContent,
    ).toBe("2");
  });

  it("marks failed when a failed stage slug is provided", () => {
    const timeline = buildStageTimeline(makeSession({ phaseStatus: "rejected" }), {
      failedStageSlug: "build",
    });
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

it.each(["in_progress", "awaiting_review"] as const)(
  "shows an active %s revisit instead of its historical completion",
  (phaseStatus) => {
    const session = makeSession({ phaseStatus });
    session.phaseCompletions.push({ stageSlug: "build", completedAt: "2026-06-07T11:30:00.000Z" });
    const timeline = buildStageTimeline(session);
    expect(timeline[1]?.status).toBe("current");
    render(
      createElement(StageTimeline, { onSelect: vi.fn(), selectedStageSlug: "build", timeline }),
    );
    const label = phaseStatus === "in_progress" ? "In progress" : "Awaiting review";
    expect(
      screen.getByRole("button", { name: `Build: ${label}` }).getAttribute("aria-current"),
    ).toBe("step");
  },
);

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
      stageTimelineLabel(
        buildStageTimeline(makeSession({ phaseStatus: "rejected" }), {
          failedStageSlug: "build",
        })[1]!,
      ),
    ).toBe("Failed");
    expect(
      stageTimelineLabel(
        buildStageTimeline(makeSession({ phaseStatus: "rejected" }), {
          currentRun: { ...execution, status: "canceled" },
        })[1]!,
      ),
    ).toBe("Not running");
    expect(
      stageTimelineLabel(buildStageTimeline(makeSession({ phaseStatus: "in_progress" }))[1]!),
    ).toBe("In progress");
  });

  it("marks a terminal approved stage completed before its completion event arrives", () => {
    const timeline = buildStageTimeline(
      makeSession({ currentStageId: "stage-3", currentStageSlug: "land", phaseStatus: "approved" }),
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

it("has no upcoming work after terminal approval despite a stage reorder", () => {
  const session = makeSession({ phaseStatus: "approved" });
  expect(buildStageTimeline(session).map(stageTimelineLabel)).toEqual([
    "Completed",
    "Completed",
    "Not approved",
  ]);
});

it("matches renamed stages by ID and does not transfer approval to a reused slug", () => {
  const session = makeSession();
  session.phaseCompletions = [
    { stageId: "stage-1", stageSlug: "plan", completedAt: "2026-06-07T11:00:00.000Z" },
  ];
  session.pipeline.stages[0]!.slug = "discovery";
  session.pipeline.stages[2]!.slug = "plan";
  expect(buildStageTimeline(session).map(stageTimelineLabel)).toEqual([
    "Completed",
    "Awaiting review",
    "Upcoming",
  ]);
});

it("keeps the current step after its slug changes", () => {
  const session = makeSession();
  session.pipeline.stages[1]!.slug = "implement";
  expect(buildStageTimeline(session)[1]?.status).toBe("current");
});
