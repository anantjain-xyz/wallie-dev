import type {
  PipelineDashboardCard,
  PipelineDashboardLane,
  PipelineDashboardLanePage,
} from "@/features/pipeline/types";

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
