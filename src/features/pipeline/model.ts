import type {
  PipelineBoardLane,
  PipelineBoardState,
  PipelineDashboardCard,
  PipelineDashboardLane,
  PipelineDashboardLanePage,
  PipelineDashboardPullRequest,
} from "@/features/pipeline/types";
import { PIPELINE_DASHBOARD_PAGE_SIZE } from "@/features/pipeline/types";
import { encodePipelineDashboardCursor } from "@/features/pipeline/cursor";

export type PipelineBoardAction =
  | {
      invalidatedCardIds?: ReadonlySet<string>;
      lanes: PipelineDashboardLane[];
      type: "reconcile";
    }
  | { card: PipelineDashboardCard; isInsert: boolean; type: "upsert" }
  | { cardId: string; type: "remove" }
  | { page: PipelineDashboardLanePage; type: "append-page" }
  | {
      pullRequests: PipelineDashboardPullRequest[];
      sessionId: string;
      type: "update-pull-requests";
    };

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

export function pipelineLaneKey(lane: Pick<PipelineBoardLane, "id" | "pipeline">) {
  return `${lane.pipeline.id}:${lane.id}`;
}

function sortCardIds(cardIds: Iterable<string>, cardsById: Record<string, PipelineDashboardCard>) {
  return Array.from(new Set(cardIds)).sort((leftId, rightId) =>
    comparePipelineDashboardCards(cardsById[leftId]!, cardsById[rightId]!),
  );
}

function samePullRequests(
  left: PipelineDashboardPullRequest[],
  right: PipelineDashboardPullRequest[],
) {
  return (
    left.length === right.length &&
    left.every(
      (pullRequest, index) =>
        pullRequest.id === right[index]?.id &&
        pullRequest.pullRequestNumber === right[index]?.pullRequestNumber &&
        pullRequest.pullRequestUrl === right[index]?.pullRequestUrl,
    )
  );
}

function sameCard(left: PipelineDashboardCard, right: PipelineDashboardCard) {
  return (
    left.createdAt === right.createdAt &&
    left.currentStageId === right.currentStageId &&
    left.id === right.id &&
    left.linearIssueId === right.linearIssueId &&
    left.linearIssueUrl === right.linearIssueUrl &&
    left.number === right.number &&
    left.phaseStatus === right.phaseStatus &&
    left.pipelineId === right.pipelineId &&
    left.rejectionCount === right.rejectionCount &&
    left.title === right.title &&
    left.updatedAt === right.updatedAt &&
    left.workspaceId === right.workspaceId &&
    samePullRequests(left.pullRequests, right.pullRequests)
  );
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameLaneMetadata(left: PipelineBoardLane, right: PipelineBoardLane) {
  return (
    left.cursor === right.cursor &&
    left.description === right.description &&
    left.id === right.id &&
    left.name === right.name &&
    left.pipeline.id === right.pipeline.id &&
    left.pipeline.isDefault === right.pipeline.isDefault &&
    left.pipeline.name === right.pipeline.name &&
    left.position === right.position &&
    left.slug === right.slug &&
    left.totalCount === right.totalCount
  );
}

function continuationCursor(lane: PipelineBoardLane) {
  return (
    lane.cursor ?? encodePipelineDashboardCursor({ pipelineId: lane.pipeline.id, stageId: lane.id })
  );
}

function removeCardFromLane(lane: PipelineBoardLane, cardId: string): PipelineBoardLane {
  const cardIds = lane.cardIds.filter((candidateId) => candidateId !== cardId);
  const totalCount = Math.max(0, lane.totalCount - 1);
  return {
    ...lane,
    cardIds,
    cursor: totalCount > cardIds.length ? lane.cursor : null,
    totalCount,
  };
}

export function createPipelineBoardState(lanes: PipelineDashboardLane[]): PipelineBoardState {
  const cardsById: Record<string, PipelineDashboardCard> = {};
  const claimedCardIds = new Set<string>();

  const normalizedLanes = lanes.map(({ cards, ...lane }) => {
    const cardIds: string[] = [];
    for (const card of cards) {
      if (
        claimedCardIds.has(card.id) ||
        card.pipelineId !== lane.pipeline.id ||
        card.currentStageId !== lane.id
      ) {
        continue;
      }

      claimedCardIds.add(card.id);
      cardsById[card.id] = card;
      cardIds.push(card.id);
    }

    return { ...lane, cardIds: sortCardIds(cardIds, cardsById) };
  });

  return { cardsById, lanes: normalizedLanes, offPageCardLaneKeys: {} };
}

function reconcilePipelineBoard(
  current: PipelineBoardState,
  refreshedLanes: PipelineDashboardLane[],
  invalidatedCardIds: ReadonlySet<string> = new Set(),
): PipelineBoardState {
  const refreshed = createPipelineBoardState(refreshedLanes);
  const currentByLane = new Map(current.lanes.map((lane) => [pipelineLaneKey(lane), lane]));
  const refreshedCardOwner = new Map(
    refreshed.lanes.flatMap((lane) =>
      lane.cardIds.map((cardId) => [cardId, pipelineLaneKey(lane)] as const),
    ),
  );
  const cardsById: Record<string, PipelineDashboardCard> = {};

  const lanes = refreshed.lanes.map((refreshedLane) => {
    const key = pipelineLaneKey(refreshedLane);
    const currentLane = currentByLane.get(key);
    if (!currentLane) {
      for (const cardId of refreshedLane.cardIds) {
        cardsById[cardId] = refreshed.cardsById[cardId]!;
      }
      return refreshedLane;
    }

    const candidateIds = [
      ...currentLane.cardIds.filter(
        (cardId) =>
          !invalidatedCardIds.has(cardId) &&
          current.cardsById[cardId]?.pipelineId === refreshedLane.pipeline.id &&
          current.cardsById[cardId]?.currentStageId === refreshedLane.id &&
          (!refreshedCardOwner.has(cardId) || refreshedCardOwner.get(cardId) === key),
      ),
      ...refreshedLane.cardIds,
    ];
    let entityChanged = false;
    for (const cardId of new Set(candidateIds)) {
      const currentCard = current.cardsById[cardId];
      const refreshedCard = refreshed.cardsById[cardId];
      const nextCard =
        currentCard && refreshedCard && sameCard(currentCard, refreshedCard)
          ? currentCard
          : (refreshedCard ?? currentCard);
      if (!nextCard) continue;
      cardsById[cardId] = nextCard;
      entityChanged ||= nextCard !== currentCard;
    }

    const nextLane: PipelineBoardLane = {
      ...refreshedLane,
      cardIds: sortCardIds(candidateIds, cardsById),
      cursor:
        currentLane.cardIds.length > PIPELINE_DASHBOARD_PAGE_SIZE
          ? currentLane.cursor
          : refreshedLane.cursor,
    };

    return !entityChanged &&
      sameLaneMetadata(currentLane, nextLane) &&
      sameIds(currentLane.cardIds, nextLane.cardIds)
      ? currentLane
      : nextLane;
  });

  const laneByKey = new Map(lanes.map((lane) => [pipelineLaneKey(lane), lane]));
  const offPageCardLaneKeys = Object.fromEntries(
    Object.entries(current.offPageCardLaneKeys).filter(([cardId, laneKey]) => {
      const lane = laneByKey.get(laneKey);
      return (
        !invalidatedCardIds.has(cardId) &&
        !cardsById[cardId] &&
        !!lane &&
        lane.totalCount > lane.cardIds.length
      );
    }),
  );

  return { cardsById, lanes, offPageCardLaneKeys };
}

function upsertPipelineCard(
  state: PipelineBoardState,
  card: PipelineDashboardCard,
  isInsert: boolean,
): PipelineBoardState {
  const existingLaneIndex = state.lanes.findIndex((lane) => lane.cardIds.includes(card.id));
  const offPageLaneKey = state.offPageCardLaneKeys[card.id];
  const offPageLaneIndex = offPageLaneKey
    ? state.lanes.findIndex((lane) => pipelineLaneKey(lane) === offPageLaneKey)
    : -1;
  const sourceLaneIndex = existingLaneIndex >= 0 ? existingLaneIndex : offPageLaneIndex;
  const targetLaneIndex = state.lanes.findIndex(
    (lane) => lane.pipeline.id === card.pipelineId && lane.id === card.currentStageId,
  );

  if (targetLaneIndex < 0 || (sourceLaneIndex < 0 && !isInsert)) return state;

  if (sourceLaneIndex < 0) {
    const targetLane = state.lanes[targetLaneIndex]!;
    const hasRoom = targetLane.cardIds.length < PIPELINE_DASHBOARD_PAGE_SIZE;
    const cardsById = hasRoom ? { ...state.cardsById, [card.id]: card } : state.cardsById;
    const offPageCardLaneKeys = hasRoom
      ? state.offPageCardLaneKeys
      : {
          ...state.offPageCardLaneKeys,
          [card.id]: pipelineLaneKey(targetLane),
        };
    const lanes = state.lanes.map((lane, laneIndex) =>
      laneIndex === targetLaneIndex
        ? {
            ...lane,
            cardIds: hasRoom ? sortCardIds([...lane.cardIds, card.id], cardsById) : lane.cardIds,
            cursor: hasRoom ? lane.cursor : continuationCursor(lane),
            totalCount: lane.totalCount + 1,
          }
        : lane,
    );
    return { cardsById, lanes, offPageCardLaneKeys };
  }

  if (sourceLaneIndex === targetLaneIndex && existingLaneIndex < 0) return state;

  const targetHasRoom =
    sourceLaneIndex === targetLaneIndex ||
    state.lanes[targetLaneIndex]!.cardIds.length < PIPELINE_DASHBOARD_PAGE_SIZE;
  const currentCard = state.cardsById[card.id];
  const nextCard =
    currentCard && card.pullRequests !== currentCard.pullRequests
      ? { ...card, pullRequests: currentCard.pullRequests }
      : card;
  const cardsById = { ...state.cardsById };
  const offPageCardLaneKeys = { ...state.offPageCardLaneKeys };
  delete offPageCardLaneKeys[card.id];
  if (targetHasRoom) {
    cardsById[card.id] = nextCard;
  } else {
    delete cardsById[card.id];
    offPageCardLaneKeys[card.id] = pipelineLaneKey(state.lanes[targetLaneIndex]!);
  }
  const lanes = state.lanes.map((lane, laneIndex) => {
    if (laneIndex !== sourceLaneIndex && laneIndex !== targetLaneIndex) return lane;

    if (sourceLaneIndex === targetLaneIndex) {
      return { ...lane, cardIds: sortCardIds(lane.cardIds, cardsById) };
    }

    if (laneIndex === sourceLaneIndex) {
      return removeCardFromLane(lane, card.id);
    }

    return {
      ...lane,
      cardIds: targetHasRoom ? sortCardIds([...lane.cardIds, card.id], cardsById) : lane.cardIds,
      cursor: targetHasRoom ? lane.cursor : continuationCursor(lane),
      totalCount: lane.totalCount + 1,
    };
  });

  return { cardsById, lanes, offPageCardLaneKeys };
}

function removePipelineCard(state: PipelineBoardState, cardId: string): PipelineBoardState {
  const laneIndex = state.lanes.findIndex((lane) => lane.cardIds.includes(cardId));
  const offPageLaneKey = state.offPageCardLaneKeys[cardId];
  const sourceLaneIndex =
    laneIndex >= 0
      ? laneIndex
      : state.lanes.findIndex((lane) => pipelineLaneKey(lane) === offPageLaneKey);
  if (sourceLaneIndex < 0) return state;

  const cardsById = { ...state.cardsById };
  delete cardsById[cardId];
  const offPageCardLaneKeys = { ...state.offPageCardLaneKeys };
  delete offPageCardLaneKeys[cardId];
  const lanes = state.lanes.map((lane, index) =>
    index === sourceLaneIndex ? removeCardFromLane(lane, cardId) : lane,
  );
  return { cardsById, lanes, offPageCardLaneKeys };
}

function appendPipelineBoardLanePage(
  state: PipelineBoardState,
  page: PipelineDashboardLanePage,
): PipelineBoardState {
  const requestedLaneIndex = state.lanes.findIndex(
    (lane) => lane.id === page.id && lane.pipeline.id === page.pipeline.id,
  );
  if (requestedLaneIndex < 0) return state;

  const idsOwnedByOtherLanes = new Set(
    state.lanes.flatMap((lane, laneIndex) =>
      laneIndex === requestedLaneIndex ? [] : lane.cardIds,
    ),
  );
  const safeCards = page.cards.filter(
    (card) =>
      card.pipelineId === page.pipeline.id &&
      card.currentStageId === page.id &&
      !idsOwnedByOtherLanes.has(card.id),
  );
  const cardsById = { ...state.cardsById };
  const offPageCardLaneKeys = { ...state.offPageCardLaneKeys };
  for (const card of safeCards) {
    cardsById[card.id] = card;
    delete offPageCardLaneKeys[card.id];
  }

  const lanes = state.lanes.map((lane, laneIndex) =>
    laneIndex === requestedLaneIndex
      ? {
          ...lane,
          cardIds: sortCardIds([...lane.cardIds, ...safeCards.map((card) => card.id)], cardsById),
          cursor: page.cursor,
          totalCount: page.totalCount,
        }
      : lane,
  );

  return { cardsById, lanes, offPageCardLaneKeys };
}

function updatePipelineCardPullRequests(
  state: PipelineBoardState,
  sessionId: string,
  pullRequests: PipelineDashboardPullRequest[],
): PipelineBoardState {
  const card = state.cardsById[sessionId];
  const laneIndex = state.lanes.findIndex((lane) => lane.cardIds.includes(sessionId));
  if (!card || laneIndex < 0 || samePullRequests(card.pullRequests, pullRequests)) return state;

  return {
    cardsById: { ...state.cardsById, [sessionId]: { ...card, pullRequests } },
    lanes: state.lanes.map((lane, index) => (index === laneIndex ? { ...lane } : lane)),
    offPageCardLaneKeys: state.offPageCardLaneKeys,
  };
}

export function pipelineBoardReducer(
  state: PipelineBoardState,
  action: PipelineBoardAction,
): PipelineBoardState {
  switch (action.type) {
    case "append-page":
      return appendPipelineBoardLanePage(state, action.page);
    case "reconcile":
      return reconcilePipelineBoard(state, action.lanes, action.invalidatedCardIds);
    case "remove":
      return removePipelineCard(state, action.cardId);
    case "update-pull-requests":
      return updatePipelineCardPullRequests(state, action.sessionId, action.pullRequests);
    case "upsert":
      return upsertPipelineCard(state, action.card, action.isInsert);
  }
}
