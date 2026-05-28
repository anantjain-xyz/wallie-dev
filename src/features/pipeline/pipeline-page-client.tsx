"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import type {
  PipelineDashboardCard,
  PipelineDashboardData,
  PipelineDashboardPullRequest,
} from "@/features/pipeline/data";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import { SessionPhaseStatusLabel } from "@/features/sessions/components/session-phase-status-label";
import { type SessionPhaseStatus } from "@/features/sessions/types";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Tables } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

type PipelinePageClientProps = {
  initialData: PipelineDashboardData;
};

const OTHER_LANE = { name: "Other", slug: "__other__" };
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
  const [cards, setCards] = useState<PipelineDashboardCard[]>(initialData.cards);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  // Index of stage_id → slug, built once from the default-pipeline payload.
  // Realtime updates carry stage IDs; we resolve them locally so we don't
  // round-trip per change.
  const stageIdToSlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of initialData.defaultPipelineStages) {
      map.set(stage.id, stage.slug);
    }
    return map;
  }, [initialData.defaultPipelineStages]);

  useEffect(() => {
    async function refreshSessionPullRequests(sessionId: string) {
      const { data, error } = await supabase
        .from("session_pull_requests")
        .select("id, is_draft, pull_request_number, pull_request_state, pull_request_url")
        .eq("workspace_id", initialData.workspace.id)
        .eq("session_id", sessionId)
        .not("pull_request_url", "is", null)
        .order("created_at", { ascending: false });

      if (error) {
        return;
      }

      const pullRequests: PipelineDashboardPullRequest[] = (data ?? []).map((row) => ({
        id: row.id,
        isDraft: row.is_draft,
        pullRequestNumber: row.pull_request_number,
        pullRequestState: row.pull_request_state,
        pullRequestUrl: row.pull_request_url,
        repositoryFullName: null,
      }));

      setCards((prev) =>
        prev.map((card) => (card.id === sessionId ? { ...card, pullRequests } : card)),
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
            setCards((prev) => prev.filter((card) => card.id !== oldId));
            return;
          }

          const row = payload.new as Tables<"sessions">;

          if (row.archived_at) {
            setCards((prev) => prev.filter((card) => card.id !== row.id));
            return;
          }

          setCards((prev) => {
            const idx = prev.findIndex((card) => card.id === row.id);
            const existing = idx === -1 ? null : prev[idx]!;
            // When the session's stage changes (approval advanced it), we
            // must re-resolve the slug from current_stage_id — keeping the
            // existing slug would leave the card in the old lane until a
            // full reload. If the stage didn't change, the cached slug is
            // fine (and is the only way we'd know the slug for sessions
            // pinned to a non-default stage).
            const stageChanged = !existing || existing.currentStageId !== row.current_stage_id;
            const slug = stageChanged
              ? (stageIdToSlug.get(row.current_stage_id) ?? "unknown")
              : existing.currentStageSlug;
            const next: PipelineDashboardCard = {
              createdAt: row.created_at,
              currentStageId: row.current_stage_id,
              currentStageSlug: slug,
              id: row.id,
              linearIssueId: row.linear_issue_id,
              linearIssueUrl: row.linear_issue_url,
              number: row.number,
              phaseStatus: row.phase_status as SessionPhaseStatus,
              rejectionCount: row.rejection_count,
              pullRequests: existing?.pullRequests ?? [],
              title: row.title,
              updatedAt: row.updated_at,
              workspaceId: row.workspace_id,
            };
            if (idx === -1) return [next, ...prev];
            const copy = prev.slice();
            copy[idx] = next;
            return copy;
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
  }, [initialData.workspace.id, stageIdToSlug, supabase]);

  // Lanes: every default stage gets a column, plus an "Other" column for
  // sessions whose stage doesn't appear in the default (e.g. an admin renamed
  // a stage while the session was in flight).
  const lanes = useMemo(() => {
    const knownSlugs = new Set(initialData.defaultPipelineStages.map((s) => s.slug));
    const order: { slug: string; name: string; description: string }[] =
      initialData.defaultPipelineStages.map((s) => ({
        description: s.description,
        name: s.name,
        slug: s.slug,
      }));
    const buckets = new Map<string, PipelineDashboardCard[]>();
    for (const lane of order) buckets.set(lane.slug, []);
    let hasOther = false;
    for (const card of cards) {
      const target = knownSlugs.has(card.currentStageSlug)
        ? card.currentStageSlug
        : OTHER_LANE.slug;
      if (!knownSlugs.has(card.currentStageSlug)) hasOther = true;
      const list = buckets.get(target) ?? [];
      if (!buckets.has(target)) buckets.set(target, list);
      list.push(card);
    }
    if (hasOther) {
      order.push({ description: "Sessions on a non-default stage.", ...OTHER_LANE });
    }
    for (const list of buckets.values()) {
      list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return { buckets, order };
  }, [cards, initialData.defaultPipelineStages]);
  const boardWidthPx = lanes.order.length * LANE_WIDTH_PX;
  const boardContainerWidth = `${boardWidthPx || LANE_WIDTH_PX}px`;

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

      <div className="px-4 pb-10 md:hidden">
        <div className="space-y-6">
          {lanes.order.map((lane) => {
            const items = lanes.buckets.get(lane.slug) ?? [];

            return (
              <section key={lane.slug} className="border-t border-border/70 pt-4 first:border-t-0">
                <header className="mb-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="truncate text-[15px] font-semibold text-foreground">
                      {lane.name}
                    </h2>
                    <span className="font-mono text-[11px] tabular-nums text-muted">
                      {items.length}
                    </span>
                  </div>
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
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div className="hidden overflow-x-auto overscroll-x-contain px-6 pb-12 sm:px-8 md:block">
        <div className="mx-auto flex" style={{ width: boardContainerWidth }}>
          {lanes.order.map((lane) => {
            const items = lanes.buckets.get(lane.slug) ?? [];
            return (
              <section
                key={lane.slug}
                className="flex min-h-[calc(100vh-230px)] w-[260px] shrink-0 flex-col border-l border-border/70 px-3 first:border-l-0 first:pl-0 last:pr-0"
              >
                <header className="pb-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <h2 className="truncate text-[14px] font-semibold text-foreground">
                      {lane.name}
                    </h2>
                    <span className="font-mono text-[11px] tabular-nums text-muted">
                      {items.length}
                    </span>
                  </div>
                  <div className="min-w-0">
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
                </div>
              </section>
            );
          })}
        </div>
      </div>
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
        card.phaseStatus === "rejected" && "border-danger/30 border-l-2 border-l-danger",
      )}
    >
      <Link
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
