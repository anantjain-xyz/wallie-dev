import type {
  PipelineDashboardCard,
  PipelineDashboardLane,
  PipelineDashboardLanePage,
} from "@/features/pipeline/types";
import { PIPELINE_DASHBOARD_PAGE_SIZE } from "@/features/pipeline/types";

function attentionRank(card: PipelineDashboardCard) {
  return card.phaseStatus === "awaiting_review" ? 0 : 1;
}

export function comparePipelineDashboardCards(
  left: PipelineDashboardCard,
  right: PipelineDashboardCard,
) {
  const rankDifference = attentionRank(left) - attentionRank(right);
  if (rankDifference !== 0) return rankDifference;

  const updatedAtDifference = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedAtDifference !== 0) return updatedAtDifference;

  return right.id.localeCompare(left.id);
}

export function appendPipelineLanePage(
  lane: PipelineDashboardLane,
  page: PipelineDashboardLanePage,
): PipelineDashboardLane {
  if (lane.id !== page.id || lane.pipeline.id !== page.pipeline.id) {
    return lane;
  }

  const cardsById = new Map(lane.cards.map((card) => [card.id, card]));
  for (const card of page.cards) {
    cardsById.set(card.id, card);
  }

  return {
    ...lane,
    cards: Array.from(cardsById.values()).sort(comparePipelineDashboardCards),
    cursor: page.cursor,
    totalCount: page.totalCount,
  };
}

export function appendPipelineBoardLanePage(
  lanes: PipelineDashboardLane[],
  page: PipelineDashboardLanePage,
) {
  const requestedLaneIndex = lanes.findIndex(
    (lane) => lane.id === page.id && lane.pipeline.id === page.pipeline.id,
  );
  if (requestedLaneIndex < 0) return lanes;

  const cardIdsOwnedByOtherLanes = new Set(
    lanes.flatMap((lane, laneIndex) =>
      laneIndex === requestedLaneIndex ? [] : lane.cards.map((card) => card.id),
    ),
  );
  const safePage = {
    ...page,
    cards: page.cards.filter(
      (card) =>
        card.pipelineId === page.pipeline.id &&
        card.currentStageId === page.id &&
        !cardIdsOwnedByOtherLanes.has(card.id),
    ),
  };

  return lanes.map((lane, laneIndex) =>
    laneIndex === requestedLaneIndex ? appendPipelineLanePage(lane, safePage) : lane,
  );
}

function laneKey(lane: Pick<PipelineDashboardLane, "id" | "pipeline">) {
  return `${lane.pipeline.id}:${lane.id}`;
}

export function reconcilePipelineDashboardLanes(
  currentLanes: PipelineDashboardLane[],
  refreshedLanes: PipelineDashboardLane[],
  invalidatedCardIds: ReadonlySet<string> = new Set(),
) {
  const currentByLane = new Map(currentLanes.map((lane) => [laneKey(lane), lane]));
  const refreshedCardOwner = new Map(
    refreshedLanes.flatMap((lane) => lane.cards.map((card) => [card.id, laneKey(lane)] as const)),
  );

  return refreshedLanes.map((refreshedLane) => {
    const key = laneKey(refreshedLane);
    const currentLane = currentByLane.get(key);
    if (!currentLane) return refreshedLane;

    const cardsById = new Map(
      currentLane.cards
        .filter(
          (card) =>
            !invalidatedCardIds.has(card.id) &&
            card.pipelineId === refreshedLane.pipeline.id &&
            card.currentStageId === refreshedLane.id &&
            (!refreshedCardOwner.has(card.id) || refreshedCardOwner.get(card.id) === key),
        )
        .map((card) => [card.id, card]),
    );
    for (const card of refreshedLane.cards) {
      cardsById.set(card.id, card);
    }

    return {
      ...refreshedLane,
      cards: Array.from(cardsById.values()).sort(comparePipelineDashboardCards),
      cursor:
        currentLane.cards.length > PIPELINE_DASHBOARD_PAGE_SIZE
          ? currentLane.cursor
          : refreshedLane.cursor,
    };
  });
}

export function upsertPipelineRealtimeCard(
  lanes: PipelineDashboardLane[],
  card: PipelineDashboardCard,
  isInsert: boolean,
) {
  const existingLaneIndex = lanes.findIndex((lane) =>
    lane.cards.some((candidate) => candidate.id === card.id),
  );
  const targetLaneIndex = lanes.findIndex(
    (lane) => lane.pipeline.id === card.pipelineId && lane.id === card.currentStageId,
  );

  // An update for an unloaded card is outside the currently loaded slice. Let a
  // refresh or explicit Load more request reconcile it instead of growing the lane.
  if (existingLaneIndex < 0 && !isInsert) return lanes;

  // A new or moved card can enter only when the target's initial visible slice
  // still has room. Loaded pages grow exclusively through the Load more action.
  const targetHasRoom =
    targetLaneIndex >= 0 &&
    (targetLaneIndex === existingLaneIndex ||
      lanes[targetLaneIndex]!.cards.length < PIPELINE_DASHBOARD_PAGE_SIZE);

  if (existingLaneIndex < 0 && !targetHasRoom) return lanes;

  return lanes.map((lane, laneIndex) => {
    if (laneIndex !== existingLaneIndex && laneIndex !== targetLaneIndex) return lane;

    const cards = lane.cards.filter((candidate) => candidate.id !== card.id);
    let totalCount = lane.totalCount;

    if (laneIndex === existingLaneIndex && laneIndex !== targetLaneIndex) {
      totalCount = Math.max(0, totalCount - 1);
    }

    if (laneIndex === targetLaneIndex) {
      if (targetHasRoom) {
        cards.push(card);
        cards.sort(comparePipelineDashboardCards);
      }

      if (existingLaneIndex !== targetLaneIndex && (existingLaneIndex >= 0 || isInsert)) {
        totalCount += 1;
      }
    }

    return { ...lane, cards, totalCount };
  });
}
