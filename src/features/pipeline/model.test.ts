import { describe, expect, it } from "vitest";

import { encodePipelineDashboardCursor } from "@/features/pipeline/cursor";
import { createPipelineBoardState, pipelineBoardReducer } from "@/features/pipeline/model";
import type { PipelineDashboardCard, PipelineDashboardLane } from "@/features/pipeline/types";

const PIPELINE_ID = "10000000-0000-4000-8000-000000000001";
const PLAN_STAGE_ID = "20000000-0000-4000-8000-000000000001";
const BUILD_STAGE_ID = "20000000-0000-4000-8000-000000000002";

function card(
  number: number,
  stageId = PLAN_STAGE_ID,
  phaseStatus: PipelineDashboardCard["phaseStatus"] = "agent_generating",
  updatedAt = `2026-07-17T${String(number).padStart(2, "0")}:00:00Z`,
): PipelineDashboardCard {
  return {
    createdAt: updatedAt,
    currentStageId: stageId,
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    linearIssueId: null,
    linearIssueUrl: null,
    number,
    phaseStatus,
    pipelineId: PIPELINE_ID,
    pullRequests: [],
    rejectionCount: 0,
    title: `Session ${number}`,
    updatedAt,
    workspaceId: "30000000-0000-4000-8000-000000000001",
  };
}

function lane(id: string, name: string, cards: PipelineDashboardCard[]): PipelineDashboardLane {
  return {
    cards,
    cursor: "page-1",
    description: `${name} the work.`,
    id,
    name,
    pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
    position: id === PLAN_STAGE_ID ? 1 : 2,
    slug: name.toLowerCase(),
    totalCount: cards.length,
  };
}

function board() {
  return createPipelineBoardState([
    lane(PLAN_STAGE_ID, "Plan", [card(1), card(2)]),
    lane(BUILD_STAGE_ID, "Build", [card(3, BUILD_STAGE_ID)]),
  ]);
}

describe("pipelineBoardReducer", () => {
  it("normalizes cards once into an ID map and ordered per-lane ID arrays", () => {
    const duplicated = card(1);
    const state = createPipelineBoardState([
      lane(PLAN_STAGE_ID, "Plan", [duplicated]),
      lane(BUILD_STAGE_ID, "Build", [duplicated, card(3, BUILD_STAGE_ID)]),
    ]);

    expect(Object.keys(state.cardsById)).toEqual([duplicated.id, card(3).id]);
    expect(state.lanes[0]?.cardIds).toEqual([duplicated.id]);
    expect(state.lanes[1]?.cardIds).toEqual([card(3).id]);
  });

  it("inserts one entity and changes only the target lane", () => {
    const initial = board();
    const inserted = card(4, BUILD_STAGE_ID, "awaiting_review");
    const next = pipelineBoardReducer(initial, { card: inserted, isInsert: true, type: "upsert" });

    expect(next.cardsById[inserted.id]).toBe(inserted);
    expect(next.lanes[0]).toBe(initial.lanes[0]);
    expect(next.lanes[1]?.cardIds).toEqual([inserted.id, card(3).id]);
    expect(next.lanes[1]?.totalCount).toBe(2);
  });

  it("updates and reorders one entity without rebuilding unrelated lanes or cards", () => {
    const initial = board();
    const unchanged = initial.cardsById[card(2).id];
    const updated = {
      ...initial.cardsById[card(1).id]!,
      phaseStatus: "awaiting_review" as const,
      title: "Session 1 updated",
      updatedAt: "2026-07-18T01:00:00Z",
    };
    const next = pipelineBoardReducer(initial, { card: updated, isInsert: false, type: "upsert" });

    expect(next.cardsById[updated.id]).toBe(updated);
    expect(next.cardsById[card(2).id]).toBe(unchanged);
    expect(next.lanes[0]).not.toBe(initial.lanes[0]);
    expect(next.lanes[1]).toBe(initial.lanes[1]);
    expect(next.lanes[0]?.cardIds[0]).toBe(updated.id);
  });

  it("moves one entity with stable ordering and changes only source and destination lanes", () => {
    const auditStageId = "20000000-0000-4000-8000-000000000003";
    const initial = createPipelineBoardState([
      ...[
        lane(PLAN_STAGE_ID, "Plan", [card(1), card(2)]),
        lane(BUILD_STAGE_ID, "Build", [card(3, BUILD_STAGE_ID)]),
      ],
      lane(auditStageId, "Audit", [card(9, auditStageId)]),
    ]);
    const moved = {
      ...initial.cardsById[card(1).id]!,
      currentStageId: BUILD_STAGE_ID,
      updatedAt: "2026-07-18T06:00:00Z",
    };
    const next = pipelineBoardReducer(initial, { card: moved, isInsert: false, type: "upsert" });

    expect(next.lanes[0]?.cardIds).toEqual([card(2).id]);
    expect(next.lanes[1]?.cardIds).toEqual([moved.id, card(3).id]);
    expect(next.lanes[2]).toBe(initial.lanes[2]);
    expect(next.lanes[0]?.totalCount).toBe(1);
    expect(next.lanes[1]?.totalCount).toBe(2);
  });

  it("removes one entity and changes only its source lane", () => {
    const initial = board();
    const next = pipelineBoardReducer(initial, { cardId: card(1).id, type: "remove" });

    expect(next.cardsById[card(1).id]).toBeUndefined();
    expect(next.lanes[0]?.cardIds).toEqual([card(2).id]);
    expect(next.lanes[0]?.totalCount).toBe(1);
    expect(next.lanes[1]).toBe(initial.lanes[1]);
  });

  it("appends a cursor page to one lane without rebuilding other lanes", () => {
    const initial = board();
    const otherLane = initial.lanes[1];
    const otherCard = initial.cardsById[card(3).id];
    const appended = card(4);
    const next = pipelineBoardReducer(initial, {
      page: {
        cards: [appended],
        cursor: null,
        id: PLAN_STAGE_ID,
        pipeline: { id: PIPELINE_ID, isDefault: true, name: "Default" },
        totalCount: 3,
      },
      type: "append-page",
    });

    expect(next.lanes[0]?.cardIds).toContain(appended.id);
    expect(next.lanes[0]?.cursor).toBeNull();
    expect(next.lanes[1]).toBe(otherLane);
    expect(next.cardsById[card(3).id]).toBe(otherCard);
  });

  it("keeps a full visible slice bounded while incrementing its insert summary", () => {
    const cards = Array.from({ length: 25 }, (_, index) => card(index + 1));
    const initial = createPipelineBoardState([lane(PLAN_STAGE_ID, "Plan", cards)]);
    const inserted = card(99, PLAN_STAGE_ID, "awaiting_review");
    const next = pipelineBoardReducer(initial, { card: inserted, isInsert: true, type: "upsert" });

    expect(next.lanes[0]?.cardIds).toHaveLength(25);
    expect(next.lanes[0]?.totalCount).toBe(26);
    expect(next.cardsById[inserted.id]).toBeUndefined();
    expect(next.offPageCardLaneKeys[inserted.id]).toBe(`${PIPELINE_ID}:${PLAN_STAGE_ID}`);

    const removed = pipelineBoardReducer(next, { cardId: inserted.id, type: "remove" });
    expect(removed.lanes[0]?.totalCount).toBe(25);
    expect(removed.offPageCardLaneKeys[inserted.id]).toBeUndefined();
  });

  it("restores lane pagination when a realtime insert follows an exhausted full slice", () => {
    const cards = Array.from({ length: 25 }, (_, index) => card(index + 1));
    const exhaustedLane = { ...lane(PLAN_STAGE_ID, "Plan", cards), cursor: null };
    const initial = createPipelineBoardState([exhaustedLane]);
    const inserted = card(99, PLAN_STAGE_ID, "awaiting_review");
    const next = pipelineBoardReducer(initial, { card: inserted, isInsert: true, type: "upsert" });

    expect(next.lanes[0]?.cardIds).toEqual(initial.lanes[0]?.cardIds);
    expect(next.lanes[0]?.cursor).toBe(
      encodePipelineDashboardCursor({ pipelineId: PIPELINE_ID, stageId: PLAN_STAGE_ID }),
    );
    expect(next.lanes[0]?.totalCount).toBe(26);
    expect(next.offPageCardLaneKeys[inserted.id]).toBe(`${PIPELINE_ID}:${PLAN_STAGE_ID}`);

    const removed = pipelineBoardReducer(next, { cardId: inserted.id, type: "remove" });
    expect(removed.lanes[0]?.cardIds).toEqual(initial.lanes[0]?.cardIds);
    expect(removed.lanes[0]?.cursor).toBeNull();
    expect(removed.lanes[0]?.totalCount).toBe(25);
  });

  it("keeps a full destination slice bounded when a loaded card moves into it", () => {
    const buildCards = Array.from({ length: 25 }, (_, index) =>
      card(
        index + 10,
        BUILD_STAGE_ID,
        "agent_generating",
        `2026-07-17T00:${String(index).padStart(2, "0")}:00Z`,
      ),
    );
    const moving = card(1);
    const initial = createPipelineBoardState([
      lane(PLAN_STAGE_ID, "Plan", [moving]),
      lane(BUILD_STAGE_ID, "Build", buildCards),
    ]);
    const moved = { ...moving, currentStageId: BUILD_STAGE_ID };
    const next = pipelineBoardReducer(initial, { card: moved, isInsert: false, type: "upsert" });

    expect(next.lanes[0]?.cardIds).toEqual([]);
    expect(next.lanes[0]?.totalCount).toBe(0);
    expect(next.lanes[1]?.cardIds).toEqual(initial.lanes[1]?.cardIds);
    expect(next.lanes[1]?.totalCount).toBe(26);
    expect(next.cardsById[moved.id]).toBeUndefined();
    expect(next.offPageCardLaneKeys[moved.id]).toBe(`${PIPELINE_ID}:${BUILD_STAGE_ID}`);
  });

  it("preserves reducer-current pull requests across a stale session upsert", () => {
    const initial = board();
    const session = initial.cardsById[card(1).id]!;
    const pullRequests = [
      { id: "pr-1", pullRequestNumber: 260, pullRequestUrl: "https://github.com/example/pr/260" },
    ];
    const withPullRequests = pipelineBoardReducer(initial, {
      pullRequests,
      sessionId: session.id,
      type: "update-pull-requests",
    });
    const staleSessionEvent = { ...session, title: "Updated title" };
    const next = pipelineBoardReducer(withPullRequests, {
      card: staleSessionEvent,
      isInsert: false,
      type: "upsert",
    });

    expect(next.cardsById[session.id]?.title).toBe("Updated title");
    expect(next.cardsById[session.id]?.pullRequests).toBe(pullRequests);
  });
});
