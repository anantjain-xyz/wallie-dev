"use client";

import { useEffect, useMemo, useState } from "react";

import { appendPipelineBoardLanePage, upsertPipelineRealtimeCard } from "@/features/pipeline/model";
import type {
  PipelineDashboardCard,
  PipelineDashboardData,
  PipelineDashboardLane,
  PipelineDashboardLanePage,
  PipelineDashboardPullRequest,
} from "@/features/pipeline/types";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import {
  SessionDetailLink,
  SessionDetailLinkPrefetchBoundary,
} from "@/features/sessions/components/session-detail-link";
import { SessionPhaseStatusLabel } from "@/features/sessions/components/session-phase-status-label";
import { SessionsZeroState } from "@/features/sessions/components/sessions-zero-state";
import { type SessionPhaseStatus } from "@/features/sessions/types";
import { workspaceBasePath, workspaceSessionDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Tables } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

type PipelinePageClientProps = {
  initialData: PipelineDashboardData;
};

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

export function PipelinePageClient({ initialData }: PipelinePageClientProps) {
  return (
    <SessionDetailLinkPrefetchBoundary>
      <PipelinePageContent initialData={initialData} />
    </SessionDetailLinkPrefetchBoundary>
  );
}

function PipelinePageContent({ initialData }: PipelinePageClientProps) {
  const [lanes, setLanes] = useState<PipelineDashboardLane[]>(initialData.lanes);
  const [loadingLaneId, setLoadingLaneId] = useState<string | null>(null);
  const [laneErrors, setLaneErrors] = useState<Record<string, string>>({});
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  useEffect(() => {
    async function refreshSessionPullRequests(sessionId: string) {
      const { data, error } = await supabase
        .from("session_pull_requests")
        .select("id, pull_request_number, pull_request_url")
        .eq("workspace_id", initialData.workspace.id)
        .eq("session_id", sessionId)
        .not("pull_request_url", "is", null)
        .order("created_at", { ascending: false });

      if (error) {
        return;
      }

      const pullRequests: PipelineDashboardPullRequest[] = (data ?? []).map((row) => ({
        id: row.id,
        pullRequestNumber: row.pull_request_number,
        pullRequestUrl: row.pull_request_url,
      }));

      setLanes((prev) =>
        prev.map((lane) => ({
          ...lane,
          cards: lane.cards.map((card) =>
            card.id === sessionId ? { ...card, pullRequests } : card,
          ),
        })),
      );
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
            if (!oldId) return;
            setLanes((prev) => removeLoadedCard(prev, oldId));
            return;
          }

          const row = payload.new as Tables<"sessions">;

          if (row.archived_at) {
            setLanes((prev) => removeLoadedCard(prev, row.id));
            return;
          }

          setLanes((prev) => {
            const existing = prev.flatMap((lane) => lane.cards).find((card) => card.id === row.id);
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

            return upsertPipelineRealtimeCard(prev, next, payload.eventType === "INSERT");
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
          const row =
            payload.eventType === "DELETE"
              ? (payload.old as { session_id?: string } | null)
              : (payload.new as { session_id?: string } | null);
          if (!row?.session_id) return;
          void refreshSessionPullRequests(row.session_id);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [initialData.workspace.id, supabase]);

  async function loadMore(lane: PipelineDashboardLane) {
    if (!lane.cursor || loadingLaneId) return;

    setLoadingLaneId(lane.id);
    setLaneErrors((prev) => ({ ...prev, [lane.id]: "" }));

    try {
      const response = await fetch(
        `/api/workspaces/${initialData.workspace.id}/pipeline-dashboard`,
        {
          body: JSON.stringify({
            cursor: lane.cursor,
            pipelineId: lane.pipeline.id,
            seenIds: lane.cards.map((card) => card.id),
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

      setLanes((prev) => appendPipelineBoardLanePage(prev, payload.lane!));
    } catch (error) {
      setLaneErrors((prev) => ({
        ...prev,
        [lane.id]: error instanceof Error ? error.message : "Failed to load more sessions.",
      }));
    } finally {
      setLoadingLaneId(null);
    }
  }

  const boardWidthPx = lanes.length * LANE_WIDTH_PX;
  const boardContainerWidth = `${boardWidthPx || LANE_WIDTH_PX}px`;
  const hasAnySession = lanes.some((lane) => lane.totalCount > 0);

  return (
    <div className="min-h-full bg-surface">
      <header className="px-4 pb-8 pt-10 sm:px-8 md:pb-10 md:pt-14">
        <div className="mx-auto w-full" style={{ maxWidth: boardContainerWidth }}>
          <div className="max-w-2xl space-y-2">
            <h1 className="text-[28px] font-semibold tracking-tight text-balance text-foreground">
              Pipeline
            </h1>
            <p className="text-[14px] leading-6 text-muted">
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
          <div className="px-4 pb-10 md:hidden">
            <div className="space-y-6">
              {lanes.map((lane) => {
                const items = lane.cards;
                return (
                  <section
                    key={`${lane.pipeline.id}:${lane.id}`}
                    className="border-t border-border/70 pt-4 first:border-t-0"
                  >
                    <header className="mb-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="truncate text-[15px] font-semibold text-foreground">
                          {lane.name}
                        </h2>
                        <span className="font-mono text-[11px] tabular-nums text-muted">
                          {lane.totalCount}
                        </span>
                      </div>
                      {!lane.pipeline.isDefault ? (
                        <p className="mt-1 text-[11px] font-medium text-muted">
                          {lane.pipeline.name}
                        </p>
                      ) : null}
                      <p className="mt-1 text-[12px] leading-5 text-muted">{lane.description}</p>
                    </header>

                    <div className="space-y-2">
                      {items.length === 0 ? (
                        <p className="rounded-[8px] border border-dashed border-border px-4 py-5 text-[12px] text-muted">
                          No sessions
                        </p>
                      ) : null}

                      {items.map((card) => (
                        <PipelineCard
                          key={card.id}
                          card={card}
                          workspaceSlug={initialData.workspace.slug}
                        />
                      ))}

                      <PipelineLanePagination
                        error={laneErrors[lane.id]}
                        isLoading={loadingLaneId === lane.id}
                        lane={lane}
                        onLoadMore={loadMore}
                      />
                    </div>
                  </section>
                );
              })}
            </div>
          </div>

          <div className="hidden overflow-x-auto overscroll-x-contain px-6 pb-12 sm:px-8 md:block">
            <div className="mx-auto flex" style={{ width: boardContainerWidth }}>
              {lanes.map((lane) => {
                const items = lane.cards;
                return (
                  <section
                    key={`${lane.pipeline.id}:${lane.id}`}
                    className="flex min-h-[calc(100vh-230px)] w-[260px] shrink-0 flex-col border-l border-border/70 px-3 first:border-l-0 first:pl-0 last:pr-0"
                  >
                    <header className="pb-3">
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="truncate text-[14px] font-semibold text-foreground">
                          {lane.name}
                        </h2>
                        <span className="font-mono text-[11px] tabular-nums text-muted">
                          {lane.totalCount}
                        </span>
                      </div>
                      <div className="min-w-0">
                        {!lane.pipeline.isDefault ? (
                          <p className="mt-1 truncate text-[10px] font-medium text-muted">
                            {lane.pipeline.name}
                          </p>
                        ) : null}
                        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted">
                          {lane.description}
                        </p>
                      </div>
                    </header>

                    <div className="flex flex-1 flex-col gap-2">
                      {items.length === 0 ? (
                        <p className="py-8 text-[12px] text-muted">No sessions</p>
                      ) : null}

                      {items.map((card) => (
                        <PipelineCard
                          key={card.id}
                          card={card}
                          workspaceSlug={initialData.workspace.slug}
                        />
                      ))}

                      <PipelineLanePagination
                        error={laneErrors[lane.id]}
                        isLoading={loadingLaneId === lane.id}
                        lane={lane}
                        onLoadMore={loadMore}
                      />
                    </div>
                  </section>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function removeLoadedCard(lanes: PipelineDashboardLane[], cardId: string) {
  return lanes.map((lane) => {
    const containsCard = lane.cards.some((card) => card.id === cardId);
    if (!containsCard) return lane;

    return {
      ...lane,
      cards: lane.cards.filter((card) => card.id !== cardId),
      totalCount: Math.max(0, lane.totalCount - 1),
    };
  });
}

function PipelineLanePagination({
  error,
  isLoading,
  lane,
  onLoadMore,
}: {
  error: string | undefined;
  isLoading: boolean;
  lane: PipelineDashboardLane;
  onLoadMore: (lane: PipelineDashboardLane) => Promise<void>;
}) {
  if (!lane.cursor && !error) return null;

  return (
    <div className="pt-1">
      {error ? (
        <p className="mb-2 text-[11px] leading-4 text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {lane.cursor ? (
        <button
          aria-label={`Load more ${lane.name} sessions`}
          className="ui-button w-full text-[12px]"
          disabled={isLoading}
          onClick={() => void onLoadMore(lane)}
          type="button"
        >
          {isLoading ? "Loading…" : `Load more (${lane.cards.length} of ${lane.totalCount})`}
        </button>
      ) : null}
    </div>
  );
}

function PipelineCard({
  card,
  workspaceSlug,
}: {
  card: PipelineDashboardCard;
  workspaceSlug: string;
}) {
  const pullRequests = card.pullRequests ?? [];
  const sessionHref = workspaceSessionDetailPath(workspaceSlug, card.number);

  return (
    <article
      className={cn(
        "relative rounded-[8px] border border-border/80 bg-surface p-3 transition-colors duration-150 hover:bg-surface-strong",
        // Awaiting review is the call to action — give it the loudest treatment
        // (accent border + left bar + faint accent wash) so reviewers can scan
        // the board for work that needs them.
        card.phaseStatus === "awaiting_review" &&
          "border-accent/40 border-l-2 border-l-accent bg-accent-soft hover:bg-accent-soft",
        // Rejection is a routine part of the loop (it just reruns the stage), so
        // calm it down: a thin muted danger edge instead of the old full red
        // border. The red "Rejected" chip still carries the status.
        card.phaseStatus === "rejected" && "border-l-2 border-l-danger/40",
      )}
    >
      <SessionDetailLink
        href={sessionHref}
        aria-label={`Open session ${card.title}`}
        className="absolute inset-0 z-10 rounded-[8px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h3 className="min-w-0 flex-1 text-[13px] font-medium leading-5 text-foreground">
          <span className="line-clamp-3 break-words">{card.title}</span>
        </h3>
        <SessionPhaseStatusLabel
          status={card.phaseStatus}
          className="mt-[3px] max-w-[72px] shrink-0 text-right text-[11px] font-medium leading-4"
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        <SessionConnections
          className="relative z-20"
          compact
          quiet
          linearIssueId={card.linearIssueId}
          linearIssueUrl={card.linearIssueUrl}
          pullRequestCount={pullRequests.length}
          pullRequests={pullRequests}
        />

        <dl className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {card.rejectionCount > 0 ? (
            <div className="flex items-center gap-1 text-danger">
              <dt className="sr-only">Rejections</dt>
              <dd>
                {card.rejectionCount} rejection
                {card.rejectionCount === 1 ? "" : "s"}
              </dd>
            </div>
          ) : null}

          <div className="flex items-center gap-1">
            <dt className="sr-only">Updated</dt>
            <dd>{relativeTime(card.updatedAt)}</dd>
          </div>
        </dl>
      </div>
    </article>
  );
}
