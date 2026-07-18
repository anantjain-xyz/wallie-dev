import { describe, expect, it } from "vitest";

import {
  appendPipelineBoardLanePage,
  appendPipelineLanePage,
  reconcilePipelineDashboardLanes,
  upsertPipelineRealtimeCard,
} from "@/features/pipeline/model";
import type { PipelineDashboardCard, PipelineDashboardLane } from "@/features/pipeline/types";

const PIPELINE_ID = "10000000-0000-4000-8000-000000000001";
const STAGE_ID = "20000000-0000-4000-8000-000000000001";

function card(
  id: string,
  phaseStatus: PipelineDashboardCard["phaseStatus"],
  updatedAt: string,
): PipelineDashboardCard {
  return {
    createdAt: updatedAt,
    currentStageId: STAGE_ID,
    id,
    linearIssueId: null,
    linearIssueUrl: null,
    number: Number(id.at(-1)),
    phaseStatus,
    pipelineId: PIPELINE_ID,
    pullRequests: [],
    rejectionCount: 0,
    title: id,
    updatedAt,
    workspaceId: "30000000-0000-4000-8000-000000000001",
  };
}

function lane(cards: PipelineDashboardCard[]): PipelineDashboardLane {
  return {
    cards,
    cursor: "page-1",
    description: "",
    id: STAGE_ID,
    name: "Plan",
    pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
    position: 1,
    slug: "plan",
    totalCount: Math.max(4, cards.length),
  };
}

describe("appendPipelineLanePage", () => {
  it("appends only the requested lane and keeps attention-first stable ordering", () => {
    const initial = lane([
      card("00000000-0000-4000-8000-000000000001", "agent_generating", "2026-07-17T04:00:00Z"),
      card("00000000-0000-4000-8000-000000000002", "agent_generating", "2026-07-17T03:00:00Z"),
    ]);
    const result = appendPipelineLanePage(initial, {
      cards: [
        card("00000000-0000-4000-8000-000000000003", "awaiting_review", "2026-07-17T01:00:00Z"),
        card("00000000-0000-4000-8000-000000000004", "agent_generating", "2026-07-17T02:00:00Z"),
      ],
      cursor: null,
      id: STAGE_ID,
      pipeline: initial.pipeline,
      totalCount: 4,
    });

    expect(result.cards.map((item) => item.id.at(-1))).toEqual(["3", "1", "2", "4"]);
    expect(result.cursor).toBeNull();
  });

  it("deduplicates a concurrently updated card instead of appending it twice", () => {
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const initial = lane([card(sessionId, "agent_generating", "2026-07-17T01:00:00Z")]);
    const result = appendPipelineLanePage(initial, {
      cards: [card(sessionId, "awaiting_review", "2026-07-17T05:00:00Z")],
      cursor: "snapshot-page-2",
      id: STAGE_ID,
      pipeline: initial.pipeline,
      totalCount: 4,
    });

    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({
      phaseStatus: "awaiting_review",
      updatedAt: "2026-07-17T05:00:00Z",
    });
  });

  it("ignores a page for a different pinned pipeline lane", () => {
    const initial = lane([]);
    const result = appendPipelineLanePage(initial, {
      cards: [],
      cursor: null,
      id: STAGE_ID,
      pipeline: { ...initial.pipeline, id: "90000000-0000-4000-8000-000000000001" },
      totalCount: 0,
    });

    expect(result).toBe(initial);
  });
});

describe("concurrent dashboard updates", () => {
  it("adds refreshed lane metadata without discarding already loaded cards", () => {
    const secondCard = card(
      "00000000-0000-4000-8000-000000000002",
      "agent_generating",
      "2026-07-17T02:00:00Z",
    );
    const currentLane = lane([
      card("00000000-0000-4000-8000-000000000001", "agent_generating", "2026-07-17T01:00:00Z"),
      secondCard,
    ]);
    const newStageId = "50000000-0000-4000-8000-000000000001";
    const refreshedLane = {
      ...lane([secondCard]),
      description: "Updated description",
      totalCount: 2,
    };
    const newLane = {
      ...lane([]),
      cursor: null,
      id: newStageId,
      name: "Review",
      position: 2,
      slug: "review",
      totalCount: 0,
    };

    const result = reconcilePipelineDashboardLanes([currentLane], [refreshedLane, newLane]);

    expect(result).toHaveLength(2);
    expect(result[0]?.description).toBe("Updated description");
    expect(result[0]?.cards).toHaveLength(2);
    expect(result[1]).toEqual(newLane);
  });

  it("removes an invalidated card from its old lane when refreshed into a new lane", () => {
    const movedId = "00000000-0000-4000-8000-000000000009";
    const currentLane = lane([card(movedId, "agent_generating", "2026-07-17T01:00:00Z")]);
    const newStageId = "50000000-0000-4000-8000-000000000001";
    const movedCard = {
      ...card(movedId, "agent_generating", "2026-07-17T02:00:00Z"),
      currentStageId: newStageId,
    };
    const newLane = {
      ...lane([movedCard]),
      cursor: null,
      id: newStageId,
      name: "Review",
      position: 2,
      slug: "review",
      totalCount: 1,
    };

    const result = reconcilePipelineDashboardLanes(
      [currentLane],
      [{ ...currentLane, cards: [], totalCount: 0 }, newLane],
      new Set([movedId]),
    );

    expect(result[0]?.cards).toEqual([]);
    expect(result[1]?.cards).toEqual([movedCard]);
  });

  it("does not restore a stale load-more card after realtime moved it to another lane", () => {
    const movedId = "00000000-0000-4000-8000-000000000009";
    const buildStageId = "50000000-0000-4000-8000-000000000001";
    const planLane = lane([]);
    const movedCard = {
      ...card(movedId, "agent_generating", "2026-07-17T06:00:00Z"),
      currentStageId: buildStageId,
    };
    const buildLane = {
      ...lane([movedCard]),
      cursor: null,
      id: buildStageId,
      name: "Build",
      slug: "build",
      totalCount: 1,
    };

    const result = appendPipelineBoardLanePage([planLane, buildLane], {
      cards: [card(movedId, "agent_generating", "2026-07-17T05:00:00Z")],
      cursor: null,
      id: STAGE_ID,
      pipeline: planLane.pipeline,
      totalCount: 1,
    });

    expect(result[0]?.cards).toEqual([]);
    expect(result[1]?.cards).toEqual([movedCard]);
  });

  it("ignores off-page realtime updates so a loaded slice remains bounded", () => {
    const cards = Array.from({ length: 25 }, (_, index) =>
      card(
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        "agent_generating",
        `2026-07-17T${String(index).padStart(2, "0")}:00:00Z`,
      ),
    );
    const initial = [lane(cards)];
    const offPageCard = card(
      "00000000-0000-4000-8000-000000000099",
      "awaiting_review",
      "2026-07-18T00:00:00Z",
    );

    const result = upsertPipelineRealtimeCard(initial, offPageCard, false);

    expect(result).toBe(initial);
    expect(result[0]?.cards).toHaveLength(25);
  });

  it("does not let realtime inserts grow a full initial lane", () => {
    const cards = Array.from({ length: 25 }, (_, index) =>
      card(
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        "agent_generating",
        `2026-07-17T${String(index).padStart(2, "0")}:00:00Z`,
      ),
    );
    const initial = [lane(cards)];
    const inserted = card(
      "00000000-0000-4000-8000-000000000099",
      "awaiting_review",
      "2026-07-18T00:00:00Z",
    );

    const result = upsertPipelineRealtimeCard(initial, inserted, true);

    expect(result).toBe(initial);
    expect(result[0]?.cards).toHaveLength(25);
    expect(result[0]?.totalCount).toBe(25);
  });
});
