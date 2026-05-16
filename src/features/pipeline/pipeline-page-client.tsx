"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { StatusChip } from "@/components/shared/status-chip";
import type { PipelineDashboardCard, PipelineDashboardData } from "@/features/pipeline/data";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import {
  formatSessionPhaseStatus,
  sessionPhaseStatusTone,
  type SessionPhaseStatus,
} from "@/features/sessions/types";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Tables } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

type PipelinePageClientProps = {
  initialData: PipelineDashboardData;
};

const OTHER_LANE = { name: "Other", slug: "__other__" };

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

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <div className="flex-1 overflow-x-auto px-6 py-6">
        <div className="flex gap-4">
          {lanes.order.map((lane) => {
            const items = lanes.buckets.get(lane.slug) ?? [];
            return (
              <section
                key={lane.slug}
                className="flex min-h-[200px] min-w-[220px] flex-1 flex-col rounded-[8px] border border-border bg-surface"
              >
                <header className="flex items-baseline justify-between border-b border-border px-3 py-2.5">
                  <div>
                    <h2 className="text-[13px] font-semibold text-foreground">{lane.name}</h2>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">{lane.description}</p>
                  </div>
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted">
                    {items.length}
                  </span>
                </header>

                <div className="flex flex-1 flex-col gap-2 p-2">
                  {items.length === 0 ? (
                    <p className="px-2 py-6 text-center text-[12px] text-muted">No sessions.</p>
                  ) : null}

                  {items.map((card) => (
                    <article
                      key={card.id}
                      className={cn(
                        "rounded-[6px] border border-border bg-background p-3 shadow-sm",
                        card.phaseStatus === "rejected" && "border-danger/30",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-[13px] font-medium leading-5 text-foreground">
                          <Link
                            href={workspaceSessionDetailPath(
                              initialData.workspace.slug,
                              card.number,
                            )}
                            className="hover:underline"
                          >
                            {card.title}
                          </Link>
                        </h3>
                        <StatusChip tone={sessionPhaseStatusTone(card.phaseStatus)}>
                          {formatSessionPhaseStatus(card.phaseStatus)}
                        </StatusChip>
                      </div>

                      <div className="mt-2">
                        <SessionConnections
                          compact
                          linearIssueId={card.linearIssueId}
                          linearIssueUrl={card.linearIssueUrl}
                          pullRequestCount={0}
                        />
                      </div>

                      <dl className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
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
                    </article>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}
