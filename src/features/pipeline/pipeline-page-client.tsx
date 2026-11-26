"use client";

import { useRouter } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createContext,
  memo,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { FilterSearch, FilterSelectTrigger, ClearFilters } from "@/components/ui/filter-controls";
import { Select, SelectContent, SelectItem } from "@/components/ui/select";
import {
  sessionDisplayStatus,
  type SessionDisplayStatus,
} from "@/features/sessions/display-status";
import { TimeDisplay } from "@/components/shared/time-display";
import { CommandBar, PageHeader } from "@/components/ui/page-shell";
import {
  STATUS_DEFINITIONS,
  Status,
  sessionPhaseStatusValue,
  type StatusValue,
} from "@/components/ui/status";
import { withFactoryQuery } from "@/features/factories/factory-selection";
import { pipelineLayout } from "@/features/pipeline/layout";
import {
  createPipelineBoardState,
  pipelineBoardReducer,
  pipelineRecoveryNeedsFollowup,
  pipelineLaneKey,
  type PipelineRecoveryChanges,
} from "@/features/pipeline/model";
import type {
  PipelineBoardLane,
  PipelineBoardState,
  PipelineDashboardCard,
  PipelineDashboardData,
  PipelineDashboardLanePage,
  PipelineDashboardPullRequest,
  PipelineStatusFilter,
} from "@/features/pipeline/types";
import { PIPELINE_SEARCH_MAX_LENGTH } from "@/features/pipeline/types";
import {
  SessionDetailLink,
  SessionDetailLinkPrefetchBoundary,
} from "@/features/sessions/components/session-detail-link";
import { SessionsZeroState } from "@/features/sessions/components/sessions-zero-state";
import { useRealtimeRecovery } from "@/features/wallie/realtime-recovery-context";
import { RecoveryDeferredError } from "@/features/wallie/realtime-recovery";
import { type SessionPhaseStatus } from "@/features/sessions/types";
import { loginPath, workspaceBasePath, workspaceSessionDetailPath } from "@/lib/routes";
import { subscribeAuthenticatedChannel } from "@/lib/supabase/realtime-subscription";
import { useSupabasePublicConfig } from "@/lib/supabase/public-config-provider";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { isUnmodifiedPrimaryClick } from "@/lib/telemetry/interaction-rum";
import { cn } from "@/lib/utils";

type PipelinePageClientProps = {
  /** When false, skip Supabase realtime (fixtures / offline proof captures). */
  enableRealtime?: boolean;
  factorySelector?: ReactNode;
  initialData: PipelineDashboardData;
  initialNow?: string;
};

type PendingCardFocus = {
  cardId: string;
  focusableIndex: number;
  targetLaneKey: string;
};

type DashboardCardStatus = SessionDisplayStatus;
type StatusFilter = PipelineStatusFilter;

const CARD_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const LANE_MIN_WIDTH_PX = 280;
const ISOLATED_RENDER_NOW = "1970-01-01T00:00:00.000Z";
const FILTER_DEBOUNCE_MS = 200;
const PipelineCardActivation = createContext<RefObject<AbortController | null> | null>(null);

const STATUS_FILTER_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All statuses" },
  { key: "awaiting_review", label: STATUS_DEFINITIONS.awaiting_review.label },
  { key: "in_progress", label: STATUS_DEFINITIONS.in_progress.label },
  { key: "approved", label: STATUS_DEFINITIONS.approved.label },
  { key: "rejected", label: STATUS_DEFINITIONS.rejected.label },
  { key: "failed", label: STATUS_DEFINITIONS.failed.label },
];

const STATUS_SUMMARY_ORDER: DashboardCardStatus[] = [
  "awaiting_review",
  "in_progress",
  "failed",
  "rejected",
  "approved",
];

export const pipelineDashboardCardStatus = sessionDisplayStatus;

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

type LaneVisibleCardsCacheEntry = {
  cardIds: string[];
  cards: Array<PipelineDashboardCard | undefined>;
  cardsById: Record<string, PipelineDashboardCard>;
  visibleCards: PipelineDashboardCard[];
};

function canReuseCachedLaneVisibleCards(
  cached: LaneVisibleCardsCacheEntry | undefined,
  lane: PipelineBoardLane,
  cardsById: Record<string, PipelineDashboardCard>,
): cached is LaneVisibleCardsCacheEntry {
  if (!cached) return false;
  if (cached.cardIds === lane.cardIds && cached.cardsById === cardsById) {
    return true;
  }
  if (cached.cardIds.length !== lane.cardIds.length) {
    return false;
  }
  for (let index = 0; index < lane.cardIds.length; index += 1) {
    const cardId = lane.cardIds[index]!;
    if (cached.cardIds[index] !== cardId || cached.cards[index] !== cardsById[cardId]) {
      return false;
    }
  }
  return true;
}

export function summarizeLaneStatuses(
  cards: readonly PipelineDashboardCard[],
): { count: number; label: string; value: StatusValue }[] {
  const counts = new Map<DashboardCardStatus, number>();
  for (const card of cards) {
    const status = pipelineDashboardCardStatus(card);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  return STATUS_SUMMARY_ORDER.flatMap((status) => {
    const count = counts.get(status) ?? 0;
    if (count === 0) return [];
    const value = status === "failed" ? status : sessionPhaseStatusValue(status);
    return [{ count, label: STATUS_DEFINITIONS[value].label.toLowerCase(), value }];
  });
}

export function formatLaneStateSummary(
  cards: readonly PipelineDashboardCard[],
  options?: { isPartial?: boolean },
) {
  const parts = summarizeLaneStatuses(cards).map(({ count, label }) => `${count} ${label}`);
  if (parts.length === 0) {
    return options?.isPartial ? "No sessions loaded" : "No active sessions";
  }
  const summary = parts.join(" · ");
  return options?.isPartial ? `Loaded: ${summary}` : summary;
}

export function PipelinePageClient({
  enableRealtime = true,
  factorySelector,
  initialData,
  initialNow,
}: PipelinePageClientProps) {
  const openingCard = useRef<AbortController | null>(null);
  return (
    <SessionDetailLinkPrefetchBoundary>
      <PipelineCardActivation.Provider value={openingCard}>
        <PipelinePageContent
          key={`${initialData.workspace.id}:${initialData.factoryId ?? "all"}`}
          enableRealtime={enableRealtime}
          factorySelector={factorySelector}
          initialData={initialData}
          initialNow={initialNow}
        />
      </PipelineCardActivation.Provider>
    </SessionDetailLinkPrefetchBoundary>
  );
}

function PipelinePageContent({
  enableRealtime = true,
  factorySelector,
  initialData,
  initialNow,
}: PipelinePageClientProps) {
  const router = useRouter();
  const { factoryId } = initialData;
  const dashboardHref = withFactoryQuery(
    `/api/workspaces/${initialData.workspace.id}/pipeline-dashboard`,
    factoryId,
  );
  const [accessLost, setAccessLost] = useState(false);
  const accessLostRef = useRef(false);
  const renderNow = initialNow ?? ISOLATED_RENDER_NOW;
  const [unfilteredBoard, dispatch] = useReducer(
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
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filtersActive = normalizedSearchQuery.length > 0 || statusFilter !== "all";
  const filterHref = useMemo(() => {
    if (!filtersActive) return null;
    const params = new URLSearchParams();
    if (factoryId) params.set("factory", factoryId);
    if (normalizedSearchQuery) params.set("q", normalizedSearchQuery);
    if (statusFilter !== "all") params.set("status", statusFilter);
    return `/api/workspaces/${initialData.workspace.id}/pipeline-dashboard?${params}`;
  }, [factoryId, filtersActive, initialData.workspace.id, normalizedSearchQuery, statusFilter]);
  const filterHrefRef = useRef(filterHref);
  filterHrefRef.current = filterHref;
  const [filterResult, setFilterResult] = useState<{ href: string; board: PipelineBoardState }>();
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filterRevision, invalidateFilters] = useReducer((revision: number) => revision + 1, 0);
  const filteredBoard = filterResult?.href === filterHref ? filterResult?.board : undefined;
  const filtersPending = filtersActive && !filteredBoard && filterError !== filterHref;
  const board = filteredBoard ?? unfilteredBoard;
  const [hasObservedSession, setHasObservedSession] = useState(false);
  const [recoveredOnboarding, setRecoveredOnboarding] = useState<{
    initial: PipelineDashboardData["onboarding"];
    value: PipelineDashboardData["onboarding"];
  } | null>(null);
  const onboarding =
    recoveredOnboarding?.initial === initialData.onboarding
      ? recoveredOnboarding.value
      : initialData.onboarding;
  const boardRef = useRef<PipelineBoardState>(unfilteredBoard);
  const visibleBoardRef = useRef<PipelineBoardState>(board);
  const initialLanesRef = useRef(initialData.lanes);
  const invalidatedCardIds = useRef(new Set<string>());
  const loadingLaneKeyRef = useRef<string | null>(null);
  const pendingCardFocus = useRef<PendingCardFocus | null>(null);
  const { recovery } = useRealtimeRecovery();
  const eventRevision = useRef(0);
  const pageController = useRef<AbortController | null>(null);
  const supabaseConfig = useSupabasePublicConfig();
  boardRef.current = unfilteredBoard;
  visibleBoardRef.current = board;
  const [refreshRequestPending, setRefreshPending] = useState(false);
  const [refreshRenderPending, startRefresh] = useTransition();
  const refreshPending = refreshRequestPending || refreshRenderPending;
  const refreshInFlight = useRef(false);
  const refreshGeneration = useRef(0);
  const recoveryChanges = useRef<PipelineRecoveryChanges | null>(null);
  const leaveUnavailableWorkspace = useCallback(
    (status: number) => {
      if (accessLostRef.current) return;
      accessLostRef.current = true;
      pageController.current?.abort();
      setAccessLost(true);
      router.replace(
        status === 401 ? loginPath(workspaceBasePath(initialData.workspace.slug)) : "/",
      );
    },
    [initialData.workspace.slug, router],
  );
  useEffect(() => {
    pageController.current?.abort();
    pageController.current = null;
    loadingLaneKeyRef.current = null;
    setLoadingLaneKey(null);
    setLaneErrors({});
    setFilterError(null);
    setFilterResult(undefined);
  }, [filterHref]);

  useEffect(() => {
    if (!filterHref || accessLost) return;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = window.setTimeout(async () => {
      const current = () => !signal.aborted && filterHrefRef.current === filterHref;
      try {
        const response = await fetch(filterHref, { cache: "no-store", signal });
        if (!current()) return;
        if ([401, 403, 404, 409].includes(response.status)) {
          leaveUnavailableWorkspace(response.status);
          return;
        }
        if (!response.ok) throw new Error("Failed to filter the Pipeline.");
        const snapshot = (await response.json()) as Pick<PipelineDashboardData, "lanes">;
        if (!current()) return;
        const nextBoard = createPipelineBoardState(snapshot.lanes);
        const match = nextBoard.lanes.find((lane) => lane.totalCount > 0);
        startTransition(() => {
          setActiveLaneKey((key) => {
            if (visibleBoardRef.current !== boardRef.current) return key;
            if (
              !match ||
              nextBoard.lanes.some((lane) => pipelineLaneKey(lane) === key && lane.totalCount > 0)
            )
              return key;
            return pipelineLaneKey(match);
          });
          setFilterResult({ href: filterHref, board: nextBoard });
          setFilterError(null);
        });
      } catch {
        if (current()) setFilterError(filterHref);
      }
    }, FILTER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accessLost, filterHref, filterRevision, leaveUnavailableWorkspace]);

  const refreshBoard = useCallback(
    async (signal: AbortSignal) => {
      if (accessLostRef.current) return;
      if (refreshInFlight.current || loadingLaneKeyRef.current) throw new RecoveryDeferredError();
      refreshInFlight.current = true;
      setRefreshPending(true);
      const generation = ++refreshGeneration.current;
      const changes: PipelineRecoveryChanges = {
        sessions: new Map(),
        insertedSessionIds: new Set(),
        runs: new Map(),
        pullRequests: new Map(),
      };
      recoveryChanges.current = changes;
      try {
        const response = await fetch(dashboardHref, { cache: "no-store", signal });
        if (signal.aborted || generation !== refreshGeneration.current) return;
        if ([401, 403, 404, 409].includes(response.status)) {
          leaveUnavailableWorkspace(response.status);
          return;
        }
        if (!response.ok) throw new Error("Failed to refresh pipeline.");
        const snapshot = (await response.json()) as Pick<
          PipelineDashboardData,
          "lanes" | "hasAnySession" | "onboarding"
        >;
        if (signal.aborted || generation !== refreshGeneration.current || accessLostRef.current)
          return;
        const focusTargetLaneKey = pendingCardFocus.current?.targetLaneKey;
        startRefresh(() => {
          if (focusTargetLaneKey) setActiveLaneKey(focusTargetLaneKey);
          dispatch({ lanes: snapshot.lanes, changes, type: "recover" });
        });
        if (snapshot.hasAnySession) setHasObservedSession(true);
        if (filterHrefRef.current) invalidateFilters();
        if ("onboarding" in snapshot)
          setRecoveredOnboarding({ initial: initialData.onboarding, value: snapshot.onboarding });
        invalidatedCardIds.current.clear();
        if (pipelineRecoveryNeedsFollowup(snapshot.lanes, changes)) recovery.invalidate();
      } finally {
        if (recoveryChanges.current === changes && generation === refreshGeneration.current) {
          recoveryChanges.current = null;
          refreshInFlight.current = false;
          setRefreshPending(false);
        }
      }
    },
    [dashboardHref, initialData.onboarding, leaveUnavailableWorkspace, recovery, startRefresh],
  );

  useEffect(() => {
    if (initialLanesRef.current === initialData.lanes) return;
    initialLanesRef.current = initialData.lanes;
    const invalidated = new Set(invalidatedCardIds.current);
    startTransition(() => {
      dispatch({ invalidatedCardIds: invalidated, lanes: initialData.lanes, type: "reconcile" });
    });
    invalidatedCardIds.current.clear();
  }, [initialData.lanes]);

  useEffect(
    () => () => {
      // The controller's batch signal can outlive this registration. Fence every
      // response when this workspace instance unmounts, including StrictMode.
      refreshGeneration.current += 1;
      refreshInFlight.current = false;
      recoveryChanges.current = null;
      pageController.current?.abort();
    },
    [],
  );

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
    const focusables = cardElement
      ? Array.from(cardElement.querySelectorAll<HTMLElement>(CARD_FOCUSABLE_SELECTOR))
      : [];
    // Prefer the recorded control; if it vanished (e.g. Review CTA after approve),
    // fall back to the first remaining focusable on the card.
    const focusTarget = focusables[pending.focusableIndex] ?? focusables[0];
    if (focusTarget) {
      focusTarget.focus({ preventScroll: true });
      pendingCardFocus.current = null;
      return;
    }

    if (!board.cardsById[pending.cardId]) {
      const mobileStageTab = document.querySelector<HTMLElement>(
        `[data-pipeline-stage-tab="${pending.targetLaneKey}"]`,
      );
      if (mobileStageTab?.offsetParent) {
        mobileStageTab.focus({ preventScroll: true });
      }
    }
    pendingCardFocus.current = null;
  }, [board]);

  useEffect(() => {
    if (!enableRealtime || accessLost) return;
    const prRequests = new Map<string, number>();
    async function refreshSessionPullRequests(
      supabase: SupabaseClient<Database>,
      sessionId: string,
      isCurrent: () => boolean,
    ) {
      const requestId = (prRequests.get(sessionId) ?? 0) + 1;
      prRequests.set(sessionId, requestId);
      const startedAtGeneration = refreshGeneration.current;
      const { data, error } = await supabase
        .from("session_pull_requests")
        .select(
          "id, pull_request_number, pull_request_url, github_repository_id, github_repositories(factory_id), sessions(factory_id)",
        )
        .eq("workspace_id", initialData.workspace.id)
        .eq("session_id", sessionId)
        .not("pull_request_url", "is", null)
        .order("created_at", { ascending: false });

      if (
        !isCurrent() ||
        prRequests.get(sessionId) !== requestId ||
        startedAtGeneration !== refreshGeneration.current
      )
        return;
      if (error) {
        recovery.invalidate();
        return;
      }

      const pullRequests: PipelineDashboardPullRequest[] = (data ?? [])
        .filter(
          (row) =>
            !row.github_repository_id ||
            (row.github_repositories &&
              row.sessions?.factory_id === row.github_repositories.factory_id),
        )
        .map((row) => ({
          id: row.id,
          pullRequestNumber: row.pull_request_number,
          pullRequestUrl: row.pull_request_url,
        }));

      recoveryChanges.current?.pullRequests.set(sessionId, pullRequests);
      dispatch({ pullRequests, sessionId, type: "update-pull-requests" });
    }

    return recovery.register({
      key: `pipeline:${initialData.workspace.id}${factoryId ? `:${factoryId}` : ""}`,
      role: "page",
      required: true,
      refresh: refreshBoard,
      subscribe: (onStatus, isCurrent) => {
        let cancelled = false;
        let unsubscribe: (() => void) | undefined;
        void import("@/lib/supabase/browser")
          .then(({ createSupabaseBrowserClient }) => {
            if (cancelled || !isCurrent()) return;
            const supabase = createSupabaseBrowserClient(supabaseConfig);
            const channel = supabase
              .channel(`sessions:${initialData.workspace.id}${factoryId ? `:${factoryId}` : ""}`)
              .on(
                "postgres_changes",
                {
                  event: "*",
                  filter: factoryId
                    ? `factory_id=eq.${factoryId}`
                    : `workspace_id=eq.${initialData.workspace.id}`,
                  schema: "public",
                  table: "sessions",
                },
                (payload) => {
                  if (!isCurrent()) return;
                  if (filterHrefRef.current) invalidateFilters();
                  if (payload.eventType === "DELETE") {
                    const oldId = (payload.old as { id?: string } | null)?.id;
                    if (oldId) {
                      if (
                        !boardRef.current.cardsById[oldId] &&
                        !boardRef.current.offPageCardLaneKeys[oldId]
                      ) {
                        if (factoryId) return;
                        recovery.invalidate();
                      }
                      eventRevision.current += 1;
                      recoveryChanges.current?.sessions.set(oldId, null);
                      dispatch({ cardId: oldId, type: "remove" });
                    }
                    return;
                  }

                  const row = payload.new as Tables<"sessions">;
                  if (factoryId && row.factory_id !== factoryId) return;
                  eventRevision.current += 1;
                  setHasObservedSession(true);
                  if (row.archived_at) {
                    if (
                      !boardRef.current.cardsById[row.id] &&
                      !boardRef.current.offPageCardLaneKeys[row.id]
                    )
                      recovery.invalidate();
                    recoveryChanges.current?.sessions.set(row.id, null);
                    dispatch({ cardId: row.id, type: "remove" });
                    return;
                  }

                  const currentBoard = boardRef.current;
                  const existing = currentBoard.cardsById[row.id];
                  const next: PipelineDashboardCard = {
                    createdAt: row.created_at,
                    currentStageId: row.current_stage_id,
                    id: row.id,
                    latestRunId: existing?.latestRunId ?? null,
                    latestRunStatus: existing?.latestRunStatus ?? null,
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
                  recoveryChanges.current?.sessions.set(next.id, next);
                  if (payload.eventType === "INSERT")
                    recoveryChanges.current?.insertedSessionIds.add(next.id);
                  const hasTargetLane = currentBoard.lanes.some(
                    (lane) =>
                      lane.pipeline.id === next.pipelineId && lane.id === next.currentStageId,
                  );
                  const targetLaneKey = `${next.pipelineId}:${next.currentStageId}`;
                  const focus = captureCardFocus(next.id, targetLaneKey);
                  if (focus) pendingCardFocus.current = focus;

                  if (
                    !existing &&
                    !currentBoard.offPageCardLaneKeys[next.id] &&
                    payload.eventType !== "INSERT"
                  ) {
                    recovery.invalidate();
                  }
                  if (!hasTargetLane) {
                    invalidatedCardIds.current.add(next.id);
                    recovery.invalidate();
                    return;
                  }

                  const moved =
                    !!existing &&
                    (existing.pipelineId !== next.pipelineId ||
                      existing.currentStageId !== next.currentStageId);
                  if (moved) {
                    startTransition(() => {
                      if (focus) setActiveLaneKey(focus.targetLaneKey);
                      dispatch({
                        card: next,
                        isInsert: payload.eventType === "INSERT",
                        type: "upsert",
                      });
                    });
                    return;
                  }

                  dispatch({
                    card: next,
                    isInsert: payload.eventType === "INSERT",
                    type: "upsert",
                  });
                },
              )
              .on(
                "postgres_changes",
                {
                  event: "*",
                  filter: `workspace_id=eq.${initialData.workspace.id}`,
                  schema: "public",
                  table: "agent_runs",
                },
                (payload) => {
                  if (!isCurrent()) return;
                  if (filterHrefRef.current) invalidateFilters();
                  eventRevision.current += 1;
                  if (payload.eventType === "DELETE") {
                    const deletedRun = payload.old as { id?: string; session_id?: string } | null;
                    const card = deletedRun?.session_id
                      ? boardRef.current.cardsById[deletedRun.session_id]
                      : null;
                    if (card?.latestRunId === deletedRun?.id) recovery.invalidate();
                    return;
                  }

                  const run = payload.new as Pick<
                    Tables<"agent_runs">,
                    "id" | "session_id" | "status"
                  >;
                  const priorRun = recoveryChanges.current?.runs.get(run.session_id);
                  recoveryChanges.current?.runs.set(run.session_id, {
                    runId: run.id,
                    runStatus: run.status,
                    isInsert:
                      payload.eventType === "INSERT" ||
                      (priorRun?.runId === run.id && priorRun.isInsert),
                  });
                  dispatch({
                    isInsert: payload.eventType === "INSERT",
                    runId: run.id,
                    runStatus: run.status,
                    sessionId: run.session_id,
                    type: "update-run",
                  });
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
                  if (!isCurrent()) return;
                  if (filterHrefRef.current) invalidateFilters();
                  eventRevision.current += 1;
                  const row =
                    payload.eventType === "DELETE"
                      ? (payload.old as { session_id?: string } | null)
                      : (payload.new as { session_id?: string } | null);
                  if (row?.session_id)
                    void refreshSessionPullRequests(supabase, row.session_id, isCurrent);
                },
              );
            unsubscribe = subscribeAuthenticatedChannel(supabase, channel, onStatus);
          })
          .catch((error: unknown) => {
            if (!cancelled && isCurrent()) onStatus("CHANNEL_ERROR", error);
          });
        return () => {
          cancelled = true;
          unsubscribe?.();
        };
      },
    });
  }, [
    accessLost,
    enableRealtime,
    factoryId,
    initialData.workspace.id,
    recovery,
    refreshBoard,
    supabaseConfig,
  ]);

  const loadMore = useCallback(
    async (requestedLaneKey: string) => {
      if (
        accessLostRef.current ||
        filtersPending ||
        loadingLaneKeyRef.current ||
        refreshInFlight.current ||
        refreshPending
      )
        return;
      const lane = visibleBoardRef.current.lanes.find(
        (candidate) => pipelineLaneKey(candidate) === requestedLaneKey,
      );
      if (!lane?.cursor) return;

      const controller = new AbortController();
      pageController.current = controller;
      const revision = eventRevision.current;
      loadingLaneKeyRef.current = requestedLaneKey;
      setLoadingLaneKey(requestedLaneKey);
      setLaneErrors((current) => ({ ...current, [requestedLaneKey]: "" }));

      try {
        const response = await fetch(filterHref ?? dashboardHref, {
          body: JSON.stringify({
            cursor: lane.cursor,
            pipelineId: lane.pipeline.id,
            seenIds: lane.cardIds,
            stageId: lane.id,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        if (controller.signal.aborted || filterHrefRef.current !== filterHref) return;
        if ([401, 403].includes(response.status)) {
          leaveUnavailableWorkspace(response.status);
          return;
        }
        const payload = (await response.json()) as {
          code?: string;
          error?: string;
          lane?: PipelineDashboardLanePage;
        };

        if (controller.signal.aborted || filterHrefRef.current !== filterHref) return;
        if (!response.ok && payload.code === "workspace_unavailable") {
          leaveUnavailableWorkspace(response.status);
          return;
        }

        if (!response.ok || !payload.lane) {
          throw new Error(payload.error ?? "Failed to load more sessions.");
        }

        if (controller.signal.aborted) return;
        // A bounded page cannot reconstruct counts/ownership changed mid-read.
        // Reject that snapshot instead of resurrecting deleted or moved cards.
        if (eventRevision.current !== revision) {
          recovery.invalidate();
          return;
        }
        const page = payload.lane;
        if (filterHref) {
          setFilterResult((current) =>
            current?.href === filterHref
              ? {
                  ...current,
                  board: pipelineBoardReducer(current.board, { page, type: "append-page" }),
                }
              : current,
          );
        } else {
          dispatch({ page, type: "append-page" });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setLaneErrors((current) => ({
          ...current,
          [requestedLaneKey]:
            error instanceof Error ? error.message : "Failed to load more sessions.",
        }));
      } finally {
        if (pageController.current === controller) {
          pageController.current = null;
          loadingLaneKeyRef.current = null;
          if (!controller.signal.aborted) setLoadingLaneKey(null);
        }
      }
    },
    [
      dashboardHref,
      filterHref,
      filtersPending,
      leaveUnavailableWorkspace,
      recovery,
      refreshPending,
    ],
  );

  const hasActiveSessions = unfilteredBoard.lanes.some((lane) => lane.totalCount > 0);
  const showBoard = hasActiveSessions || filtersActive;
  const hasEverHadSession = initialData.hasAnySession || hasObservedSession;
  const matchCount = filtersActive
    ? board.lanes.reduce((total, lane) => total + lane.totalCount, 0)
    : 0;
  const stageCount = Math.max(board.lanes.length, 1);
  const laneKeys = board.lanes.map((lane) => pipelineLaneKey(lane));
  const visibleCardsCacheRef = useRef<Map<string, LaneVisibleCardsCacheEntry>>(new Map());
  const visibleCardsByLane = useMemo(() => {
    const nextCache = new Map<string, LaneVisibleCardsCacheEntry>();
    for (const lane of board.lanes) {
      const key = pipelineLaneKey(lane);
      const cached = visibleCardsCacheRef.current.get(key);
      if (canReuseCachedLaneVisibleCards(cached, lane, board.cardsById)) {
        nextCache.set(key, {
          ...cached,
          cardIds: lane.cardIds,
          cardsById: board.cardsById,
        });
        continue;
      }

      const cards = lane.cardIds.map((cardId) => board.cardsById[cardId]);
      const visibleCards = cards.filter((card): card is PipelineDashboardCard => Boolean(card));
      nextCache.set(key, {
        cardIds: lane.cardIds,
        cards,
        cardsById: board.cardsById,
        visibleCards,
      });
    }
    return nextCache;
  }, [board.cardsById, board.lanes]);

  useEffect(() => {
    visibleCardsCacheRef.current = visibleCardsByLane;
  }, [visibleCardsByLane]);

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
    event.currentTarget
      .querySelector<HTMLElement>(`[data-pipeline-stage-tab="${nextKey}"]`)
      ?.focus({ preventScroll: true });
  }

  function revealFocusedStage(event: FocusEvent<HTMLDivElement>) {
    const strip = event.currentTarget;
    if (!(event.target instanceof HTMLElement) || event.target.role !== "tab") return;
    const tab = event.target.getBoundingClientRect();
    const viewport = strip.getBoundingClientRect();
    if (tab.left < viewport.left) strip.scrollLeft += tab.left - viewport.left;
    else if (tab.right > viewport.right) strip.scrollLeft += tab.right - viewport.right;
  }

  if (accessLost) return null;

  return (
    <div className={showBoard ? pipelineLayout.page : pipelineLayout.emptyPage}>
      <div className={showBoard ? pipelineLayout.controlsArea : undefined}>
        <div
          className={
            showBoard && !factorySelector ? "sr-only pipeline-wide:not-sr-only" : undefined
          }
        >
          <PageHeader
            actions={factorySelector}
            actionsRightOnDesktop
            className={showBoard ? "mb-3 pipeline-wide:mb-8" : undefined}
            description={
              <span className={showBoard ? "sr-only pipeline-wide:not-sr-only" : undefined}>
                Sessions move through these stages in order, gated by approval at each step.
              </span>
            }
            title="Pipeline"
          />
        </div>

        {showBoard ? (
          <PipelineFilters
            searchQuery={searchQuery}
            statusFilter={statusFilter}
            setSearchQuery={setSearchQuery}
            setStatusFilter={setStatusFilter}
          />
        ) : null}
        {filtersActive && filterError === filterHref ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-sm text-danger" role="alert">
              {filteredBoard ? "Couldn’t refresh matching sessions." : "Couldn’t filter sessions."}
            </p>
            <button
              className="ui-button"
              onClick={() => {
                setFilterError(null);
                invalidateFilters();
              }}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>
      <p className="sr-only" role="status">
        {filtersPending
          ? "Filtering sessions…"
          : filteredBoard
            ? matchCount === 1
              ? "1 matching session"
              : `${matchCount} matching sessions`
            : ""}
      </p>

      {!showBoard ? (
        <div>
          {initialData.showCreationOnboarding === false ? (
            <section className="ui-sheet border-dashed px-6 py-14 text-center">
              <p className="text-sm font-semibold text-foreground">No active sessions</p>
              {initialData.creationFactoryName ? (
                <p className="mt-1 text-sm text-muted">
                  New sessions start in {initialData.creationFactoryName}.
                </p>
              ) : null}
            </section>
          ) : (
            <SessionsZeroState
              onboarding={onboarding}
              variant={hasEverHadSession ? "archived" : "first-run"}
              workspaceSlug={initialData.workspace.slug}
              newSessionHref={`${workspaceBasePath(initialData.workspace.slug)}?create=1`}
            />
          )}
        </div>
      ) : filtersPending ? (
        <p aria-hidden="true" className="px-4 text-sm text-muted pipeline-wide:px-8">
          Filtering sessions…
        </p>
      ) : filtersActive && !filteredBoard ? null : (
        <>
          <div className={pipelineLayout.stageTabs}>
            <p className="sr-only" id="pipeline-stage-label">
              Pipeline stage
            </p>
            <div
              aria-labelledby="pipeline-stage-label"
              className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
              onFocus={revealFocusedStage}
              onKeyDown={handleStageTabKeyDown}
              role="tablist"
            >
              {board.lanes.map((lane) => {
                const key = pipelineLaneKey(lane);
                const selected = activeLaneKey === key;
                const context = laneContext(lane, initialData.aggregateFactories);
                const label = context ? `${context} — ${lane.name}` : lane.name;
                return (
                  <button
                    aria-controls={`pipeline-lane-panel-${key}`}
                    aria-label={`${label}, ${lane.totalCount} ${filtersActive ? "matching " : ""}${lane.totalCount === 1 ? "session" : "sessions"}`}
                    aria-selected={selected}
                    className={cn(
                      "ui-filter-chip max-w-full shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
                      selected && "ui-filter-chip-active",
                    )}
                    data-pipeline-stage-tab={key}
                    id={`pipeline-stage-tab-${key}`}
                    key={key}
                    onClick={() => setActiveLaneKey(key)}
                    role="tab"
                    tabIndex={selected ? 0 : -1}
                    type="button"
                  >
                    <span className="min-w-0 truncate">{label}</span>
                    <span className="ml-1 font-mono type-annotation tabular-nums text-muted">
                      {lane.totalCount}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div
            aria-label="Pipeline board"
            className={pipelineLayout.board}
            role="region"
            tabIndex={0}
          >
            <div
              className={pipelineLayout.grid}
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
                const visibleCards = visibleCardsByLane.get(key)?.visibleCards ?? [];

                return (
                  <PipelineLane
                    key={key}
                    error={laneErrors[key]}
                    filtersActive={filtersActive}
                    initialNow={renderNow}
                    isLoading={refreshPending || loadingLaneKey === key}
                    isMobileActive={activeLaneKey === key}
                    lane={lane}
                    context={laneContext(lane, initialData.aggregateFactories)}
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

function laneContext(lane: PipelineBoardLane, aggregateFactories?: boolean) {
  const factory = aggregateFactories ? lane.factoryName : undefined;
  const pipeline =
    !lane.pipeline.isDefault && lane.pipeline.name !== factory ? lane.pipeline.name : undefined;
  return [factory, pipeline].filter(Boolean).join(" · ");
}

const PipelineFilters = memo(function PipelineFilters({
  searchQuery,
  statusFilter,
  setSearchQuery,
  setStatusFilter,
}: {
  searchQuery: string;
  statusFilter: StatusFilter;
  setSearchQuery: (value: string) => void;
  setStatusFilter: (value: StatusFilter) => void;
}) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const filtersActive = searchQuery.trim().length > 0 || statusFilter !== "all";
  return (
    <CommandBar aria-label="Pipeline filters" className={pipelineLayout.controls}>
      <FilterSearch
        ref={searchInputRef}
        aria-label="Search pipeline sessions"
        autoComplete="off"
        description="Search all stages by title, session number, Linear issue key (e.g. OP-353), or PR number."
        maxLength={PIPELINE_SEARCH_MAX_LENGTH}
        name="q"
        onChange={(event) => setSearchQuery(event.target.value)}
        spellCheck={false}
        value={searchQuery}
      />
      <Select
        value={statusFilter}
        onValueChange={(value) => setStatusFilter(value as StatusFilter)}
      >
        <FilterSelectTrigger accessibleLabel="Filter by status">
          {STATUS_FILTER_OPTIONS.find((option) => option.key === statusFilter)?.label}
        </FilterSelectTrigger>
        <SelectContent>
          {STATUS_FILTER_OPTIONS.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filtersActive ? (
        <ClearFilters
          onClick={() => {
            setSearchQuery("");
            setStatusFilter("all");
            searchInputRef.current?.focus();
          }}
        />
      ) : null}
    </CommandBar>
  );
});

type PipelineLaneProps = {
  context: string;
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
    context,
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
    const isPartialSummary = lane.cardIds.length < lane.totalCount || Boolean(lane.cursor);
    const stateSummary =
      filtersActive && lane.totalCount === 0
        ? "No matches"
        : formatLaneStateSummary(visibleCards, { isPartial: isPartialSummary });
    const emptyCopy = lane.description.trim()
      ? lane.description.trim()
      : `Sessions enter ${lane.name} as they advance through the pipeline.`;

    return (
      <section
        aria-labelledby={headingId}
        className={cn(pipelineLayout.lane, isMobileActive ? "flex" : "hidden pipeline-wide:flex")}
        data-pipeline-lane={key}
        id={`pipeline-lane-panel-${key}`}
        role="tabpanel"
      >
        <header className={pipelineLayout.laneHeader}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="truncate text-[15px] font-semibold text-foreground" id={headingId}>
              {lane.name}
            </h2>
            <span className="font-mono type-annotation tabular-nums text-muted">
              {lane.totalCount}
            </span>
          </div>
          <div className="min-w-0">
            {context ? (
              <p className="mt-1 break-words type-annotation font-medium text-muted">{context}</p>
            ) : null}
            <p className={cn(pipelineLayout.laneSummary, "type-annotation leading-4 text-muted")}>
              {stateSummary}
            </p>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-2">
          {visibleCards.length === 0 ? (
            <p className="border-border/80 px-0 py-6 text-xs leading-5 text-muted">
              {filtersActive && lane.totalCount === 0 ? (
                <>
                  <span className="block font-medium text-foreground">
                    No matching sessions in this stage
                  </span>
                  <span className="mt-1 block">
                    Adjust the search or status filter to see more sessions.
                  </span>
                </>
              ) : lane.totalCount === 0 ? (
                <>
                  <span className="block font-medium text-foreground">
                    No sessions in this stage
                  </span>
                  <span className="mt-1 block">{emptyCopy}</span>
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
              latestRunStatus={card.latestRunStatus}
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
    previous.context === next.context &&
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

function pullRequestReferenceLabel(
  pullRequest: PipelineDashboardPullRequest,
  index: number,
  total: number,
) {
  if (pullRequest.pullRequestNumber) return `PR #${pullRequest.pullRequestNumber}`;
  return total === 1 ? "PR" : `PR ${index + 1}`;
}

function CardReferenceLine({
  linearIssueId,
  linearIssueUrl,
  number,
  pullRequests,
  rejectionCount,
}: {
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  number: number;
  pullRequests: PipelineDashboardPullRequest[];
  rejectionCount: number;
}) {
  const linkedPullRequests = pullRequests.filter((pullRequest) => pullRequest.pullRequestUrl);
  const parts: ReactNode[] = [`#${number}`];
  const linearIssueKey =
    linearIssueId && /^[a-z][a-z0-9]*-\d+$/i.test(linearIssueId) ? linearIssueId : null;

  if (linearIssueUrl) {
    parts.push(
      <a
        key="linear"
        className="pointer-events-auto underline decoration-border underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        href={linearIssueUrl}
        rel="noreferrer"
        target="_blank"
      >
        {linearIssueKey ?? "Linked Linear issue"}
      </a>,
    );
  } else if (linearIssueId) {
    parts.push(linearIssueKey ?? "Linear issue unavailable");
  }

  linkedPullRequests.forEach((pullRequest, index) => {
    parts.push(
      <a
        key={pullRequest.id}
        className="pointer-events-auto underline decoration-border underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        href={pullRequest.pullRequestUrl!}
        rel="noreferrer"
        target="_blank"
      >
        {pullRequestReferenceLabel(pullRequest, index, linkedPullRequests.length)}
      </a>,
    );
  });

  if (rejectionCount > 0) {
    parts.push(`${rejectionCount} rejection${rejectionCount === 1 ? "" : "s"}`);
  }

  return (
    <p className="type-annotation leading-4 text-muted">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          {part}
        </span>
      ))}
    </p>
  );
}

export const PipelineCard = memo(function PipelineCard({
  id,
  initialNow,
  linearIssueId,
  linearIssueUrl,
  latestRunStatus,
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
  latestRunStatus: PipelineDashboardCard["latestRunStatus"];
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
  const displayStatus = pipelineDashboardCardStatus({ latestRunStatus, phaseStatus });
  const awaitingReview = displayStatus === "awaiting_review";
  const activeCard = useContext(PipelineCardActivation);
  const activation = useRef<AbortController | null>(null);
  const [opening, startOpening] = useTransition();

  useEffect(() => () => activation.current?.abort(), []);
  useEffect(() => {
    if (!opening) return;
    const cancel = () => activation.current?.abort();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("popstate", cancel);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("popstate", cancel);
    };
  }, [opening]);

  function cancelPreviousActivation(event: MouseEvent<HTMLAnchorElement>) {
    if (!event.defaultPrevented && isUnmodifiedPrimaryClick(event)) activeCard?.current?.abort();
  }

  function openAfterPrefetch(wait: (signal: AbortSignal) => Promise<void>, navigate: () => void) {
    const controller = new AbortController();
    if (activeCard) activeCard.current = controller;
    activation.current = controller;
    startOpening(async () => {
      try {
        await wait(controller.signal);
        if (!controller.signal.aborted) startOpening(navigate);
      } finally {
        if (activeCard?.current === controller) activeCard.current = null;
        if (activation.current === controller) activation.current = null;
      }
    });
  }

  return (
    <article
      className={cn(
        "ui-sheet relative isolate border-border/80 p-3 transition-colors duration-150 hover:bg-control-hover",
        awaitingReview &&
          "border-accent/50 border-l-[3px] border-l-accent bg-accent-soft shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--accent)_18%,transparent)] hover:bg-accent-soft",
        displayStatus === "rejected" && "border-l-[3px] border-l-warning/50",
        displayStatus === "failed" && "border-l-[3px] border-l-danger/50",
      )}
      data-session-id={id}
    >
      <SessionDetailLink
        href={sessionHref}
        aria-label={`Open session ${title}`}
        className="absolute inset-0 z-10 rounded-[6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        onClick={cancelPreviousActivation}
        onDeferredNavigation={openAfterPrefetch}
      />
      <div className="pointer-events-none relative z-20 space-y-2">
        <h3 className="min-w-0 text-[13px] font-semibold leading-5 text-foreground">
          <span className="line-clamp-3 break-words">{title}</span>
        </h3>

        <Status compact value={displayStatus} />

        <CardReferenceLine
          linearIssueId={linearIssueId}
          linearIssueUrl={linearIssueUrl}
          number={number}
          pullRequests={pullRequests}
          rejectionCount={rejectionCount}
        />

        <div className="type-annotation leading-4 text-muted">
          {!opening && (
            <p>
              Updated <TimeDisplay initialNow={initialNow} value={updatedAt} variant="relative" />
            </p>
          )}
          <p role="status">{opening ? "Opening session…" : ""}</p>
        </div>

        {awaitingReview ? (
          <div className="pointer-events-auto pt-1">
            <SessionDetailLink
              aria-label={`Review session ${title}`}
              className="ui-button-primary inline-flex"
              href={sessionHref}
              onClick={cancelPreviousActivation}
              onDeferredNavigation={openAfterPrefetch}
            >
              Review
            </SessionDetailLink>
          </div>
        ) : null}
      </div>
    </article>
  );
});
