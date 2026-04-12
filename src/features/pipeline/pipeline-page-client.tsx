"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { StatusChip } from "@/components/shared/status-chip";
import { PlusIcon } from "@/components/shared/icons";
import type { PipelineDashboardCard, PipelineDashboardData } from "@/features/pipeline/data";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import { CreateSessionDialog } from "@/features/sessions/create-session-dialog";
import { normalizeLegacyPhase } from "@/features/sessions/model";
import {
  SESSION_PHASE_DESCRIPTIONS,
  SESSION_PHASE_LABELS,
  SESSION_PHASE_ORDER,
  formatSessionPhaseStatus,
  sessionPhaseStatusTone,
  type SessionPhase,
} from "@/features/sessions/types";
import { workspaceSessionDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Tables } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

type PipelinePageClientProps = {
  initialData: PipelineDashboardData;
};

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
  const [createOpen, setCreateOpen] = useState(false);
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  useEffect(() => {
    const channel = supabase
      .channel(`pipeline-issues:${initialData.workspace.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `workspace_id=eq.${initialData.workspace.id}`,
          schema: "public",
          table: "pipeline_issues",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            const oldId = (payload.old as { id?: string } | null)?.id;
            if (!oldId) return;
            setCards((prev) => prev.filter((card) => card.id !== oldId));
            return;
          }

          const row = payload.new as Tables<"pipeline_issues">;
          setCards((prev) => {
            const idx = prev.findIndex((card) => card.id === row.id);
            const next: PipelineDashboardCard = {
              createdAt: row.created_at,
              id: row.id,
              issueId: row.issue_id,
              issueNumber: idx >= 0 ? prev[idx]!.issueNumber : null,
              issueTitle: idx >= 0 ? prev[idx]!.issueTitle : "Loading…",
              linearIssueId: row.linear_issue_id,
              linearIssueUrl: row.linear_issue_url,
              phase: row.phase,
              phaseStatus: row.phase_status,
              rejectionCount: row.rejection_count,
              slackChannelId: row.slack_channel_id,
              slackThreadTs: row.slack_thread_ts,
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
  }, [initialData.workspace.id, supabase]);

  const grouped = useMemo(() => {
    const buckets = new Map<SessionPhase, PipelineDashboardCard[]>();
    for (const phase of SESSION_PHASE_ORDER) {
      buckets.set(phase, []);
    }
    for (const card of cards) {
      const phase = normalizeLegacyPhase(card.phase);
      const list = buckets.get(phase);
      if (list) {
        list.push(card);
      }
    }
    for (const list of buckets.values()) {
      list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    }
    return buckets;
  }, [cards]);

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Pipeline</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
              {initialData.workspace.name}
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-muted">
              Every Wallie session flows through product → design → engineering → review → land →
              monitor. Approve or request changes from the session detail page to advance a card.
            </p>
          </div>
          <button
            type="button"
            className="ui-button-primary inline-flex items-center gap-2"
            onClick={() => setCreateOpen(true)}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New session
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {SESSION_PHASE_ORDER.map((phase) => {
            const items = grouped.get(phase) ?? [];
            return (
              <section
                key={phase}
                className="flex min-h-[200px] flex-col rounded-[8px] border border-border bg-surface"
              >
                <header className="flex items-baseline justify-between border-b border-border px-3 py-2.5">
                  <div>
                    <h2 className="text-[13px] font-semibold text-foreground">
                      {SESSION_PHASE_LABELS[phase]}
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">
                      {SESSION_PHASE_DESCRIPTIONS[phase]}
                    </p>
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
                        card.phaseStatus === "escalated" && "border-danger/30",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-[13px] font-medium leading-5 text-foreground">
                          {card.issueNumber !== null ? (
                            <Link
                              href={workspaceSessionDetailPath(
                                initialData.workspace.slug,
                                card.issueNumber,
                              )}
                              className="hover:underline"
                            >
                              {card.issueTitle}
                            </Link>
                          ) : (
                            card.issueTitle
                          )}
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
                          slackChannelId={card.slackChannelId}
                          slackThreadTs={card.slackThreadTs}
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

      <CreateSessionDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        workspaceId={initialData.workspace.id}
        workspaceSlug={initialData.workspace.slug}
      />
    </main>
  );
}
