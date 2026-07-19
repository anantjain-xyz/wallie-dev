"use client";

import { useRouter } from "next/navigation";
import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import { SearchIcon } from "@/components/shared/icons/search-icon";
import { TimeDisplay } from "@/components/shared/time-display";
import { CommandBar, PageHeader } from "@/components/ui/page-shell";
import {
  STATUS_DEFINITIONS,
  Status,
  sessionPhaseStatusValue,
  type StatusValue,
} from "@/components/ui/status";
import {
  createPipelineBoardState,
  pipelineBoardReducer,
  pipelineLaneKey,
} from "@/features/pipeline/model";
import type {
  PipelineBoardLane,
  PipelineBoardState,
  PipelineDashboardCard,
  PipelineDashboardData,
  PipelineDashboardLanePage,
  PipelineDashboardPullRequest,
} from "@/features/pipeline/types";
import {
  SessionDetailLink,
  SessionDetailLinkPrefetchBoundary,
} from "@/features/sessions/components/session-detail-link";
import { SessionsZeroState } from "@/features/sessions/components/sessions-zero-state";
import { type SessionPhaseStatus } from "@/features/sessions/types";
import { workspaceBasePath, workspaceSessionDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Tables } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

type PipelinePageClientProps = {
  /** When false, skip Supabase realtime (fixtures / offline proof captures). */
  enableRealtime?: boolean;
  initialData: PipelineDashboardData;
  initialNow?: string;
};

type PendingCardFocus = {
  cardId: string;
  focusableIndex: number;
  targetLaneKey: string;
};

type StatusFilter = SessionPhaseStatus | "all";

const CARD_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const LANE_MIN_WIDTH_PX = 280;
const ISOLATED_RENDER_NOW = "1970-01-01T00:00:00.000Z";

const STATUS_FILTER_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All statuses" },
  { key: "awaiting_review", label: STATUS_DEFINITIONS.awaiting_review.label },
  { key: "agent_generating", label: STATUS_DEFINITIONS.agent_generating.label },
  { key: "approved", label: STATUS_DEFINITIONS.approved.label },
  { key: "rejected", label: STATUS_DEFINITIONS.rejected.label },
];

const STATUS_SUMMARY_ORDER: SessionPhaseStatus[] = [
  "awaiting_review",
  "agent_generating",
  "rejected",
  "approved",
];

function captureCardFocus(cardId: string, targetLaneKey: string): PendingCardFocus | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;

  const cardElement = activeElement.closest<HTMLElement>("[data-session-id]");
  if (!cardElement || cardElement.dataset.sessionId !== cardId) return null;

  const focusableElements = Array.from(
    cardElement.querySelectorAll<HTMLElement>(CARD_FOCUSABLE_SELECTOR),
  );
  const focusableIndex = focusableElements.indexOf(activeElement);
  return focusableIndex < 0 ? null : { cardId, focusableIndex, targetLaneKey };
}

export function cardMatchesPipelineFilters(
  card: PipelineDashboardCard,
  searchQuery: string,
  statusFilter: StatusFilter,
) {
  if (statusFilter !== "all" && card.phaseStatus !== statusFilter) return false;

  const normalized = searchQuery.trim().toLowerCase();
  if (!normalized) return true;

  const haystacks = [
    card.title,
    `#${card.number}`,
    String(card.number),
    card.linearIssueId ?? "",
    ...(card.pullRequests ?? []).flatMap((pullRequest) => [
      pullRequest.pullRequestNumber ? `pr #${pullRequest.pullRequestNumber}` : "",
      pullRequest.pullRequestNumber ? String(pullRequest.pullRequestNumber) : "",
    ]),
  ];

  return haystacks.some((value) => value.toLowerCase().includes(normalized));
}

export function summarizeLaneStatuses(
  cards: readonly PipelineDashboardCard[],
): { count: number; label: string; value: StatusValue }[] {
  const counts = new Map<SessionPhaseStatus, number>();
  for (const card of cards) {
    counts.set(card.phaseStatus, (counts.get(card.phaseStatus) ?? 0) + 1);
  }

  return STATUS_SUMMARY_ORDER.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    if (count === 0) return [];
    const value = sessionPhaseStatusValue(status);
    return [{ count, label: STATUS_DEFINITIONS[value].label.toLowerCase(), value }];
  });
}

export function formatLaneStateSummary(cards: readonly PipelineDashboardCard[]) {
  const parts = summarizeLaneStatuses(cards).map(({ count, label }) => `${count} ${label}`);
  return parts.length > 0 ? parts.join(" · ") : "No active sessions";
}

export function PipelinePageClient({
  enableRealtime = true,
  initialData,
  initialNow,
}: PipelinePageClientProps) {
  return (
    <SessionDetailLinkPrefetchBoundary>
      <PipelinePageContent
        enableRealtime={enableRealtime}
        initialData={initialData}
        initialNow={initialNow}
      />
    </SessionDetailLinkPrefetchBoundary>
  );
}

function PipelinePageContent({
  enableRealtime = true,
  initialData,
  initialNow,
}: PipelinePageClientProps) {
  const renderNow = initialNow ?? ISOLATED_RENDER_NOW;
  const [board, dispatch] = useReducer(
    pipelineBoardReducer,
    initialData.lanes,
    createPipelineBoardState,
  );
  const [activeLaneKey, setActiveLaneKey] = useState(() =>
    initialData.lanes[0] ? pipelineLaneKey(initialData.lanes[0]) : "",
  );
  const [loadingLaneKey, setLoadingLaneKey] = useState<string | null>(null);
  const [laneErrors, setLaneErrors] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const boardRef = useRef<PipelineBoardState>(board);
  const initialLanesRef = useRef(initialData.lanes);
  const invalidatedCardIds = useRef(new Set<string>());
  const laneRefreshPending = useRef(false);
  const loadingLaneKeyRef = useRef<string | null>(null);
  const pendingCardFocus = useRef<PendingCardFocus | null>(null);
  const router = useRouter();
  const supabase = useMemo(
    () => (enableRealtime ? createSupabaseBrowserClient() : null),
    [enableRealtime],
  );
  boardRef.current = board;

  useEffect(() => {
    if (initialLanesRef.current === initialData.lanes) return;
    initialLanesRef.current = initialData.lanes;
    const invalidated = new Set(invalidatedCardIds.current);
    const focusTargetLaneKey = pendingCardFocus.current?.targetLaneKey;

    startTransition(() => {
      if (focusTargetLaneKey) setActiveLaneKey(focusTargetLaneKey);
      dispatch({ invalidatedCardIds: invalidated, lanes: initialData.lanes, type: "reconcile" });
    });
    invalidatedCardIds.current.clear();
    laneRefreshPending.current = false;
  }, [initialData.lanes]);

  useEffect(() => {
    if (board.lanes.some((lane) => pipelineLaneKey(lane) === activeLaneKey)) return;
    setActiveLaneKey(board.lanes[0] ? pipelineLaneKey(board.lanes[0]) : "");
  }, [activeLaneKey, board.lanes]);

  useEffect(() => {
    const pending = pendingCardFocus.current;
    if (!pending) return;

    const cardElement = document.querySelector<HTMLElement>(
      `[data-session-id="${pending.cardId}"]`,
    );
    const focusTarget =
      cardElement?.querySelectorAll<HTMLElement>(CARD_FOCUSABLE_SELECTOR)[pending.focusableIndex];
    if (!focusTarget) {
      if (!board.cardsById[pending.cardId]) {
        const mobileStageTab = document.querySelector<HTMLElement>(
          `[data-pipeline-stage-tab="${pending.targetLaneKey}"]`,
        );
        if (mobileStageTab?.offsetParent) {
          mobileStageTab.focus({ preventScroll: true });
        }
        pendingCardFocus.current = null;
      }
      return;
    }

    focusTarget.focus({ preventScroll: true });
    pendingCardFocus.current = null;
  }, [board]);

  useEffect(() => {
    if (!supabase) return;

    async function refreshSessionPullRequests(sessionId: string) {
      const { data, error } = await supabase!
        .from("session_pull_requests")
        .select("id, pull_request_number, pull_request_url")
        .eq("workspace_id", initialData.workspace.id)
        .eq("session_id", sessionId)
        .not("pull_request_url", "is", null)
        .order("created_at", { ascending: false });

      if (error) return;

      const pullRequests: PipelineDashboardPullRequest[] = (data ?? []).map((row) => ({
        id: row.id,
        pullRequestNumber: row.pull_request_number,
        pullRequestUrl: row.pull_request_url,
      }));

      dispatch({ pullRequests, sessionId, type: "update-pull-requests" });
    }

    const channel = supabase
      .channel(`sessions:${initialData.workspace.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `workspace_id=eq.${initialData.workspace.id}`,
          schema: "public",
          table: "sessions",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldId = (payload.old as { id?: string } | null)?.id;
            if (oldId) dispatch({ cardId: oldId, type: "remove" });
            return;
          }

          const row = payload.new as Tables<"sessions">;
          if (row.archived_at) {
            dispatch({ cardId: row.id, type: "remove" });
            return;
          }

          const currentBoard = boardRef.current;
          const existing = currentBoard.cardsById[row.id];
          const next: PipelineDashboardCard = {
            createdAt: row.created_at,
            currentStageId: row.current_stage_id,
            id: row.id,
            linearIssueId: row.linear_issue_id,
            linearIssueUrl: row.linear_issue_url,
            number: row.number,
            phaseStatus: row.phase_status as SessionPhaseStatus,
            pipelineId: row.pipeline_id,
            rejectionCount: row.rejection_count,
            pullRequests: existing?.pullRequests ?? [],
            title: row.title,
            updatedAt: row.updated_at,
            workspaceId: row.workspace_id,
          };
          const hasTargetLane = currentBoard.lanes.some(
            (lane) => lane.pipeline.id === next.pipelineId && lane.id === next.currentStageId,
          );
          const targetLaneKey = `${next.pipelineId}:${next.currentStageId}`;

          if (!hasTargetLane) {
            const focus = captureCardFocus(next.id, targetLaneKey);
            if (focus) pendingCardFocus.current = focus;
            invalidatedCardIds.current.add(next.id);
            if (!laneRefreshPending.current) {
              laneRefreshPending.current = true;
              router.refresh();
            }
            return;
          }

          const moved =
            !!existing &&
            (existing.pipelineId !== next.pipelineId ||
              existing.currentStageId !== next.currentStageId);
          if (moved) {
            const focus = captureCardFocus(next.id, targetLaneKey);
            if (focus) pendingCardFocus.current = focus;
            startTransition(() => {
              if (focus) setActiveLaneKey(focus.targetLaneKey);
              dispatch({ card: next, isInsert: payload.eventType === "INSERT", type: "upsert" });
            });
            return;
          }

          dispatch({ card: next, isInsert: payload.eventType === "INSERT", type: "upsert" });
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `workspace_id=eq.${initialData.workspace.id}`,
          schema: "public",
          table: "session_pull_requests",
        },
        (payload) => {
          const row =
            payload.eventType === "DELETE"
              ? (payload.old as { session_id?: string } | null)
              : (payload.new as { session_id?: string } | null);
          if (row?.session_id) void refreshSessionPullRequests(row.session_id);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [initialData.workspace.id, router, supabase]);

  const loadMore = useCallback(
    async (requestedLaneKey: string) => {
      if (loadingLaneKeyRef.current) return;
      const lane = boardRef.current.lanes.find(
        (candidate) => pipelineLaneKey(candidate) === requestedLaneKey,
      );
      if (!lane?.cursor) return;

      loadingLaneKeyRef.current = requestedLaneKey;
      setLoadingLaneKey(requestedLaneKey);
      setLaneErrors((current) => ({ ...current, [requestedLaneKey]: "" }));

      try {
        const response = await fetch(
          `/api/workspaces/${initialData.workspace.id}/pipeline-dashboard`,
          {
            body: JSON.stringify({
              cursor: lane.cursor,
              pipelineId: lane.pipeline.id,
              seenIds: lane.cardIds,
              stageId: lane.id,
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        const payload = (await response.json()) as {
          error?: string;
          lane?: PipelineDashboardLanePage;
        };

        if (!response.ok || !payload.lane) {
          throw new Error(payload.error ?? "Failed to load more sessions.");
        }

        dispatch({ page: payload.lane, type: "append-page" });
      } catch (error) {
        setLaneErrors((current) => ({
          ...current,
          [requestedLaneKey]:
            error instanceof Error ? error.message : "Failed to load more sessions.",
        }));
      } finally {
        loadingLaneKeyRef.current = null;
        setLoadingLaneKey(null);
      }
    },
    [initialData.workspace.id],
  );

  const hasAnySession = board.lanes.some((lane) => lane.totalCount > 0);
  const filtersActive = searchQuery.trim().length > 0 || statusFilter !== "all";
  const stageCount = Math.max(board.lanes.length, 1);
  const laneKeys = board.lanes.map((lane) => pipelineLaneKey(lane));

  function handleStageTabKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    if (!(event.target instanceof Element)) return;

    const tab = event.target.closest<HTMLElement>('[role="tab"]');
    if (!tab || !event.currentTarget.contains(tab)) return;

    event.preventDefault();
    const currentKey = tab.dataset.pipelineStageTab ?? activeLaneKey;
    const currentIndex = laneKeys.indexOf(currentKey);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = Math.min(currentIndex + 1, laneKeys.length - 1);
    if (event.key === "ArrowLeft") nextIndex = Math.max(currentIndex - 1, 0);
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = laneKeys.length - 1;

    const nextKey = laneKeys[nextIndex];
    if (!nextKey || nextKey === currentKey) return;

    setActiveLaneKey(nextKey);
    document
      .querySelector<HTMLElement>(`[data-pipeline-stage-tab="${nextKey}"]`)
      ?.focus({ preventScroll: true });
  }

  return (
    <div className="min-h-[calc(100svh-3.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] bg-canvas">
      <div className="px-4 pb-4 pt-8 sm:px-8 sm:pt-10">
        <PageHeader
          description="Sessions move through these stages in order, gated by approval at each step."
          title="Pipeline"
        />

        {hasAnySession ? (
          <CommandBar aria-label="Pipeline filters" className="mb-5">
            <label className="min-w-[14rem] flex-1 space-y-1.5">
              <span className="text-[13px] font-medium text-foreground">Search</span>
              <span className="relative block">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
                <input
                  aria-label="Search pipeline sessions"
                  className="ui-input pl-8"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Title, session #, or Linear ID"
                  type="search"
                  value={searchQuery}
                />
              </span>
            </label>

            <fieldset className="space-y-1.5">
              <legend className="text-[13px] font-medium text-foreground">Status</legend>
              <div className="flex flex-wrap items-center gap-1.5">
                {STATUS_FILTER_OPTIONS.map((option) => {
                  const isSelected = statusFilter === option.key;
                  return (
                    <button
                      aria-pressed={isSelected}
                      className={cn("ui-filter-chip", isSelected && "ui-filter-chip-active")}
                      key={option.key}
                      onClick={() => setStatusFilter(option.key)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          </CommandBar>
        ) : null}
      </div>

      {!hasAnySession ? (
        <div className="px-4 pb-12 sm:px-8">
          <div className="mx-auto max-w-2xl">
            <SessionsZeroState
              onboarding={initialData.onboarding}
              workspaceSlug={initialData.workspace.slug}
              newSessionHref={`${workspaceBasePath(initialData.workspace.slug)}?create=1`}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="px-4 pb-4 md:hidden">
            <p className="text-[13px] font-medium text-foreground" id="pipeline-stage-label">
              Pipeline stage
            </p>
            <div
              aria-labelledby="pipeline-stage-label"
              className="mt-2 flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
              onKeyDown={handleStageTabKeyDown}
              role="tablist"
            >
              {board.lanes.map((lane) => {
                const key = pipelineLaneKey(lane);
                const selected = activeLaneKey === key;
                return (
                  <button
                    aria-controls={`pipeline-lane-panel-${key}`}
                    aria-selected={selected}
                    className={cn("ui-filter-chip shrink-0", selected && "ui-filter-chip-active")}
                    data-pipeline-stage-tab={key}
                    id={`pipeline-stage-tab-${key}`}
                    key={key}
                    onClick={() => setActiveLaneKey(key)}
                    role="tab"
                    tabIndex={selected ? 0 : -1}
                    type="button"
                  >
                    <span className="truncate">
                      {lane.pipeline.isDefault ? lane.name : `${lane.pipeline.name} — ${lane.name}`}
                    </span>
                    <span className="ml-1 font-mono type-annotation tabular-nums text-muted">
                      {lane.totalCount}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="max-h-[calc(100svh-12.5rem)] overflow-auto overscroll-contain px-4 pb-10 sm:px-8 md:max-h-[calc(100svh-11rem)] md:px-6 md:pb-12">
            <div
              className="pipeline-board grid w-full grid-cols-1 md:[grid-template-columns:repeat(var(--pipeline-stage-count),minmax(280px,1fr))]"
              data-pipeline-board=""
              style={
                {
                  "--pipeline-lane-min": `${LANE_MIN_WIDTH_PX}px`,
                  "--pipeline-stage-count": stageCount,
                } as CSSProperties
              }
            >
              {board.lanes.map((lane) => {
                const key = pipelineLaneKey(lane);
                const visibleCards = lane.cardIds
                  .map((cardId) => board.cardsById[cardId])
                  .filter((card): card is PipelineDashboardCard => Boolean(card))
                  .filter((card) => cardMatchesPipelineFilters(card, searchQuery, statusFilter));

                return (
                  <PipelineLane
                    key={key}
                    error={laneErrors[key]}
                    filtersActive={filtersActive}
                    initialNow={renderNow}
                    isLoading={loadingLaneKey === key}
                    isMobileActive={activeLaneKey === key}
                    lane={lane}
                    onLoadMore={loadMore}
                    visibleCards={visibleCards}
                    workspaceSlug={initialData.workspace.slug}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

type PipelineLaneProps = {
  error: string | undefined;
  filtersActive: boolean;
  initialNow: string;
  isLoading: boolean;
  isMobileActive: boolean;
  lane: PipelineBoardLane;
  onLoadMore: (laneKey: string) => Promise<void>;
  visibleCards: PipelineDashboardCard[];
  workspaceSlug: string;
};

const PipelineLane = memo(
  function PipelineLane({
    error,
    filtersActive,
    initialNow,
    isLoading,
    isMobileActive,
    lane,
    onLoadMore,
    visibleCards,
    workspaceSlug,
  }: PipelineLaneProps) {
    const key = pipelineLaneKey(lane);
    const headingId = `pipeline-lane-${key}`;
    const stateSummary = formatLaneStateSummary(visibleCards);
    const emptyCopy = lane.description.trim()
      ? lane.description.trim()
      : `Sessions enter ${lane.name} as they advance through the pipeline.`;

    return (
      <section
        aria-labelledby={headingId}
        className={cn(
          "min-h-[calc(100vh-230px)] w-full flex-col border-t border-border/70 pt-4 md:border-l md:border-t-0 md:px-3 md:pt-0 md:first:border-l-0 md:first:pl-0 md:last:pr-0",
          isMobileActive ? "flex" : "hidden md:flex",
        )}
        data-pipeline-lane={key}
        id={`pipeline-lane-panel-${key}`}
        role="tabpanel"
      >
        <header className="sticky top-0 z-10 -mx-1 mb-3 border-b border-border/60 bg-canvas/95 px-1 pb-3 backdrop-blur-sm">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="truncate text-[15px] font-semibold text-foreground" id={headingId}>
              {lane.name}
            </h2>
            <span className="font-mono type-annotation tabular-nums text-muted">
              {lane.totalCount}
            </span>
          </div>
          <div className="min-w-0">
            {!lane.pipeline.isDefault ? (
              <p className="mt-1 truncate type-annotation font-medium text-muted">
                {lane.pipeline.name}
              </p>
            ) : null}
            <p className="mt-1 type-annotation leading-4 text-muted">{stateSummary}</p>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-2">
          {visibleCards.length === 0 ? (
            <p className="border-border/80 px-0 py-6 text-xs leading-5 text-muted">
              {lane.totalCount === 0 ? (
                <>
                  <span className="block font-medium text-foreground">
                    No sessions in this stage
                  </span>
                  <span className="mt-1 block">{emptyCopy}</span>
                </>
              ) : filtersActive ? (
                <>
                  <span className="block font-medium text-foreground">
                    No matching sessions in loaded results
                  </span>
                  <span className="mt-1 block">
                    {lane.cursor
                      ? `Filters apply to loaded sessions in ${lane.name}. Load more to search further, or adjust filters.`
                      : `Adjust search or status filters to see sessions in ${lane.name}.`}
                  </span>
                </>
              ) : (
                <>
                  <span className="block font-medium text-foreground">No sessions loaded</span>
                  <span className="mt-1 block">{emptyCopy}</span>
                </>
              )}
            </p>
          ) : null}

          {visibleCards.map((card) => (
            <PipelineCard
              key={card.id}
              id={card.id}
              initialNow={initialNow}
              linearIssueId={card.linearIssueId}
              linearIssueUrl={card.linearIssueUrl}
              number={card.number}
              phaseStatus={card.phaseStatus}
              pullRequestsJson={JSON.stringify(card.pullRequests ?? [])}
              rejectionCount={card.rejectionCount}
              title={card.title}
              updatedAt={card.updatedAt}
              workspaceSlug={workspaceSlug}
            />
          ))}

          <PipelineLanePagination
            cursor={lane.cursor}
            error={error}
            isLoading={isLoading}
            laneKey={key}
            laneName={lane.name}
            loadedCount={lane.cardIds.length}
            onLoadMore={onLoadMore}
            totalCount={lane.totalCount}
          />
        </div>
      </section>
    );
  },
  (previous, next) =>
    previous.error === next.error &&
    previous.filtersActive === next.filtersActive &&
    previous.initialNow === next.initialNow &&
    previous.isLoading === next.isLoading &&
    previous.isMobileActive === next.isMobileActive &&
    previous.lane === next.lane &&
    previous.onLoadMore === next.onLoadMore &&
    previous.visibleCards === next.visibleCards &&
    previous.workspaceSlug === next.workspaceSlug,
);

const PipelineLanePagination = memo(function PipelineLanePagination({
  cursor,
  error,
  isLoading,
  laneKey,
  laneName,
  loadedCount,
  onLoadMore,
  totalCount,
}: {
  cursor: string | null;
  error: string | undefined;
  isLoading: boolean;
  laneKey: string;
  laneName: string;
  loadedCount: number;
  onLoadMore: (laneKey: string) => Promise<void>;
  totalCount: number;
}) {
  if (!cursor && !error) return null;

  return (
    <div className="pt-1">
      {error ? (
        <p className="mb-2 text-xs leading-4 text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {cursor ? (
        <button
          aria-label={`Load more ${laneName} sessions`}
          className="ui-button w-full"
          disabled={isLoading}
          onClick={() => void onLoadMore(laneKey)}
          type="button"
        >
          {isLoading ? "Loading…" : `Load more (${loadedCount} of ${totalCount})`}
        </button>
      ) : null}
    </div>
  );
});

function cardReferenceLine({
  linearIssueId,
  number,
  pullRequests,
  rejectionCount,
}: {
  linearIssueId: string | null;
  number: number;
  pullRequests: PipelineDashboardPullRequest[];
  rejectionCount: number;
}) {
  const parts = [`#${number}`];
  if (linearIssueId) parts.push(linearIssueId);
  for (const pullRequest of pullRequests) {
    if (pullRequest.pullRequestNumber) {
      parts.push(`PR #${pullRequest.pullRequestNumber}`);
    }
  }
  if (rejectionCount > 0) {
    parts.push(`${rejectionCount} rejection${rejectionCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

export const PipelineCard = memo(function PipelineCard({
  id,
  initialNow,
  linearIssueId,
  number,
  phaseStatus,
  pullRequestsJson,
  rejectionCount,
  title,
  updatedAt,
  workspaceSlug,
}: {
  id: string;
  initialNow: string;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  phaseStatus: SessionPhaseStatus;
  pullRequestsJson: string;
  rejectionCount: number;
  title: string;
  updatedAt: string;
  workspaceSlug: string;
}) {
  const pullRequests = useMemo(
    () => JSON.parse(pullRequestsJson) as PipelineDashboardPullRequest[],
    [pullRequestsJson],
  );
  const sessionHref = workspaceSessionDetailPath(workspaceSlug, number);
  const awaitingReview = phaseStatus === "awaiting_review";
  const referenceLine = cardReferenceLine({
    linearIssueId,
    number,
    pullRequests,
    rejectionCount,
  });

  return (
    <article
      className={cn(
        "ui-sheet relative border-border/80 p-3 transition-colors duration-150 hover:bg-control-hover",
        awaitingReview &&
          "border-accent/50 border-l-[3px] border-l-accent bg-accent-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_18%,transparent)] hover:bg-accent-soft",
        phaseStatus === "rejected" && "border-l-[3px] border-l-warning/50",
      )}
      data-session-id={id}
    >
      <SessionDetailLink
        href={sessionHref}
        aria-label={`Open session ${title}`}
        className="absolute inset-0 z-10 rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      />
      <div className="pointer-events-none relative z-20 space-y-2">
        <h3 className="min-w-0 text-[13px] font-semibold leading-5 text-foreground">
          <span className="line-clamp-3 break-words">{title}</span>
        </h3>

        <Status compact value={sessionPhaseStatusValue(phaseStatus)} />

        <p className="type-annotation leading-4 text-muted">{referenceLine}</p>

        <p className="type-annotation leading-4 text-muted">
          Updated <TimeDisplay initialNow={initialNow} value={updatedAt} variant="relative" />
        </p>

        {awaitingReview ? (
          <div className="pointer-events-auto pt-1">
            <SessionDetailLink
              aria-label={`Review session ${title}`}
              className="ui-button-primary inline-flex"
              href={sessionHref}
            >
              Review
            </SessionDetailLink>
          </div>
        ) : null}
      </div>
    </article>
  );
});
