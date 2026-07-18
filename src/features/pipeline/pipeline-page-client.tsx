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
} from "react";

import { Status, sessionPhaseStatusValue } from "@/components/ui/status";
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
import { SessionConnections } from "@/features/sessions/components/session-connections";
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
  initialData: PipelineDashboardData;
};

type PendingCardFocus = {
  cardId: string;
  focusableIndex: number;
};

const CARD_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const LANE_WIDTH_PX = 260;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function captureCardFocus(cardId: string): PendingCardFocus | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;

  const cardElement = activeElement.closest<HTMLElement>("[data-session-id]");
  if (!cardElement || cardElement.dataset.sessionId !== cardId) return null;

  const focusableElements = Array.from(
    cardElement.querySelectorAll<HTMLElement>(CARD_FOCUSABLE_SELECTOR),
  );
  const focusableIndex = focusableElements.indexOf(activeElement);
  return focusableIndex < 0 ? null : { cardId, focusableIndex };
}

export function PipelinePageClient({ initialData }: PipelinePageClientProps) {
  return (
    <SessionDetailLinkPrefetchBoundary>
      <PipelinePageContent initialData={initialData} />
    </SessionDetailLinkPrefetchBoundary>
  );
}

function PipelinePageContent({ initialData }: PipelinePageClientProps) {
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
  const boardRef = useRef<PipelineBoardState>(board);
  const initialLanesRef = useRef(initialData.lanes);
  const invalidatedCardIds = useRef(new Set<string>());
  const laneRefreshPending = useRef(false);
  const loadingLaneKeyRef = useRef<string | null>(null);
  const pendingCardFocus = useRef<PendingCardFocus | null>(null);
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);
  boardRef.current = board;

  useEffect(() => {
    if (initialLanesRef.current === initialData.lanes) return;
    initialLanesRef.current = initialData.lanes;
    const invalidated = new Set(invalidatedCardIds.current);

    startTransition(() => {
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
    if (!focusTarget) return;

    focusTarget.focus({ preventScroll: true });
    pendingCardFocus.current = null;
  }, [board]);

  useEffect(() => {
    async function refreshSessionPullRequests(sessionId: string) {
      const { data, error } = await supabase
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

          if (!hasTargetLane) {
            pendingCardFocus.current = captureCardFocus(next.id);
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
            pendingCardFocus.current = captureCardFocus(next.id);
            startTransition(() => {
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

  const boardWidthPx = board.lanes.length * LANE_WIDTH_PX;
  const boardContainerWidth = `${boardWidthPx || LANE_WIDTH_PX}px`;
  const hasAnySession = board.lanes.some((lane) => lane.totalCount > 0);

  return (
    <div className="min-h-full bg-canvas">
      <header className="px-4 pb-8 pt-10 sm:px-8 md:pb-10 md:pt-14">
        <div className="mx-auto w-full" style={{ maxWidth: boardContainerWidth }}>
          <div className="max-w-2xl space-y-2">
            <h1 className="type-page-title">Pipeline</h1>
            <p className="type-body text-muted">
              Sessions move through these stages in order, gated by approval at each step.
            </p>
          </div>
        </div>
      </header>

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
          <div className="px-4 pb-5 md:hidden">
            <label className="block text-xs font-medium text-muted" htmlFor="pipeline-stage">
              Pipeline stage
            </label>
            <select
              className="ui-input mt-2 w-full"
              id="pipeline-stage"
              onChange={(event) => setActiveLaneKey(event.target.value)}
              value={activeLaneKey}
            >
              {board.lanes.map((lane) => {
                const key = pipelineLaneKey(lane);
                return (
                  <option key={key} value={key}>
                    {lane.pipeline.isDefault ? lane.name : `${lane.pipeline.name} — ${lane.name}`} (
                    {lane.totalCount})
                  </option>
                );
              })}
            </select>
          </div>

          <div className="overflow-x-auto overscroll-x-contain px-4 pb-10 sm:px-8 md:px-6 md:pb-12">
            <div
              className="mx-auto flex w-full md:w-[var(--pipeline-board-width)]"
              style={{ "--pipeline-board-width": boardContainerWidth } as CSSProperties}
            >
              {board.lanes.map((lane) => {
                const key = pipelineLaneKey(lane);
                return (
                  <PipelineLane
                    key={key}
                    cardsById={board.cardsById}
                    error={laneErrors[key]}
                    isLoading={loadingLaneKey === key}
                    isMobileActive={activeLaneKey === key}
                    lane={lane}
                    onLoadMore={loadMore}
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
  cardsById: PipelineBoardState["cardsById"];
  error: string | undefined;
  isLoading: boolean;
  isMobileActive: boolean;
  lane: PipelineBoardLane;
  onLoadMore: (laneKey: string) => Promise<void>;
  workspaceSlug: string;
};

const PipelineLane = memo(
  function PipelineLane({
    cardsById,
    error,
    isLoading,
    isMobileActive,
    lane,
    onLoadMore,
    workspaceSlug,
  }: PipelineLaneProps) {
    const key = pipelineLaneKey(lane);
    const headingId = `pipeline-lane-${key}`;

    return (
      <section
        aria-labelledby={headingId}
        className={cn(
          "min-h-[calc(100vh-230px)] w-full flex-col border-t border-border/70 pt-4 md:w-[260px] md:shrink-0 md:border-l md:border-t-0 md:px-3 md:pt-0 md:first:border-l-0 md:first:pl-0 md:last:pr-0",
          isMobileActive ? "flex" : "hidden md:flex",
        )}
      >
        <header className="pb-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2
              className="truncate text-[15px] font-semibold text-foreground md:text-[14px]"
              id={headingId}
            >
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
            <p className="mt-1 text-xs leading-5 text-muted md:line-clamp-2 md:type-annotation md:leading-4">
              {lane.description}
            </p>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-2">
          {lane.cardIds.length === 0 ? (
            <p className="rounded-[6px] border border-dashed border-border px-4 py-5 text-xs text-muted md:rounded-none md:border-0 md:px-0 md:py-8">
              No sessions
            </p>
          ) : null}

          {lane.cardIds.map((cardId) => {
            const card = cardsById[cardId];
            if (!card) return null;

            return (
              <PipelineCard
                key={card.id}
                id={card.id}
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
            );
          })}

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
    previous.isLoading === next.isLoading &&
    previous.isMobileActive === next.isMobileActive &&
    previous.lane === next.lane &&
    previous.onLoadMore === next.onLoadMore &&
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

export const PipelineCard = memo(function PipelineCard({
  id,
  linearIssueId,
  linearIssueUrl,
  number,
  phaseStatus,
  pullRequestsJson,
  rejectionCount,
  title,
  updatedAt,
  workspaceSlug,
}: {
  id: string;
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

  return (
    <article
      className={cn(
        "ui-sheet relative border-border/80 p-3 transition-colors duration-150 hover:bg-control-hover",
        phaseStatus === "awaiting_review" &&
          "border-accent/40 border-l-2 border-l-accent bg-accent-soft hover:bg-accent-soft",
        phaseStatus === "rejected" && "border-l-2 border-l-danger/40",
      )}
      data-session-id={id}
    >
      <SessionDetailLink
        href={sessionHref}
        aria-label={`Open session ${title}`}
        className="absolute inset-0 z-10 rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      />
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground">
          <span className="line-clamp-3 break-words">{title}</span>
        </h3>
        <Status
          compact
          value={sessionPhaseStatusValue(phaseStatus)}
          className="mt-[1px] shrink-0"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 type-annotation text-muted">
        <SessionConnections
          className="relative z-20"
          compact
          quiet
          linearIssueId={linearIssueId}
          linearIssueUrl={linearIssueUrl}
          pullRequests={pullRequests}
        />

        <dl className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {rejectionCount > 0 ? (
            <div className="flex items-center gap-1 text-danger">
              <dt className="sr-only">Rejections</dt>
              <dd>
                {rejectionCount} rejection
                {rejectionCount === 1 ? "" : "s"}
              </dd>
            </div>
          ) : null}

          <div className="flex items-center gap-1">
            <dt className="sr-only">Updated</dt>
            <dd>{relativeTime(updatedAt)}</dd>
          </div>
        </dl>
      </div>
    </article>
  );
});
