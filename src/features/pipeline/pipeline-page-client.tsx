"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { StatusChip } from "@/components/shared/status-chip";
import type { PipelineDashboardCard, PipelineDashboardData } from "@/features/pipeline/data";
import type { PipelinePhase, PipelinePhaseStatus } from "@/lib/pipeline/types";
import { workspaceIssueDetailPath } from "@/lib/routes";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import type { Tables } from "@/lib/supabase/database.types";
import { cn } from "@/lib/utils";

type PipelinePageClientProps = {
  initialData: PipelineDashboardData;
};

const PHASE_ORDER: PipelinePhase[] = ["product", "design", "engineering", "shipped"];

const PHASE_LABELS: Record<PipelinePhase, string> = {
  design: "Design",
  engineering: "Engineering",
  product: "Product",
  shipped: "Shipped",
};

const PHASE_DESCRIPTIONS: Record<PipelinePhase, string> = {
  design: "Specs awaiting design review.",
  engineering: "Approved by design, awaiting engineering scope.",
  product: "Fresh from a Slack mention. PM review queue.",
  shipped: "Engineering approved. Pipeline complete.",
};

const STATUS_LABELS: Record<PipelinePhaseStatus, string> = {
  agent_generating: "drafting",
  approved: "approved",
  awaiting_review: "awaiting review",
  escalated: "escalated",
  rejected: "rejected",
};

function statusTone(status: PipelinePhaseStatus): "blocked" | "planned" | "ready" {
  if (status === "approved") return "ready";
  if (status === "rejected" || status === "escalated") return "blocked";
  return "planned";
}

function buildSlackThreadHref(channelId: string | null, threadTs: string | null) {
  if (!channelId || !threadTs) return null;
  // slack:// deep link plus a fallback to the web URL keeps it openable in
  // both desktop and browser without us needing the team domain.
  const tsForUrl = threadTs.replace(".", "");
  return `https://app.slack.com/client/redirect?team=&url=${encodeURIComponent(
    `slack://channel?id=${channelId}&message=${tsForUrl}`,
  )}`;
}

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
            // Realtime payloads do not include the joined `issues` row, so for
            // brand-new pipeline rows we display a placeholder title until the
            // next page load fills it in. Mutations to existing rows preserve
            // whatever title was loaded server-side.
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
    const buckets: Record<PipelinePhase, PipelineDashboardCard[]> = {
      design: [],
      engineering: [],
      product: [],
      shipped: [],
    };
    for (const card of cards) {
      buckets[card.phase].push(card);
    }
    for (const phase of PHASE_ORDER) {
      buckets[phase].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
    }
    return buckets;
  }, [cards]);

  return (
    <main className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border px-6 py-5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Pipeline</p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
          {initialData.workspace.name}
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-5 text-muted">
          Linear issues mentioned in Slack flow through Product → Design → Engineering review.
          Approve or request changes from the Slack thread to advance a card.
        </p>
      </header>

      <div className="flex-1 overflow-auto px-6 py-6">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {PHASE_ORDER.map((phase) => {
            const items = grouped[phase];
            return (
              <section
                key={phase}
                className="flex min-h-[200px] flex-col rounded-[8px] border border-border bg-surface"
              >
                <header className="flex items-baseline justify-between border-b border-border px-3 py-2.5">
                  <div>
                    <h2 className="text-[13px] font-semibold text-foreground">
                      {PHASE_LABELS[phase]}
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted">
                      {PHASE_DESCRIPTIONS[phase]}
                    </p>
                  </div>
                  <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted">
                    {items.length}
                  </span>
                </header>

                <div className="flex flex-1 flex-col gap-2 p-2">
                  {items.length === 0 ? (
                    <p className="px-2 py-6 text-center text-[12px] text-muted">No cards yet.</p>
                  ) : null}

                  {items.map((card) => {
                    const slackHref = buildSlackThreadHref(card.slackChannelId, card.slackThreadTs);
                    return (
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
                                href={workspaceIssueDetailPath(
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
                          <StatusChip tone={statusTone(card.phaseStatus)}>
                            {STATUS_LABELS[card.phaseStatus]}
                          </StatusChip>
                        </div>

                        <dl className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
                          {card.linearIssueId ? (
                            <div className="flex items-center gap-1">
                              <dt className="sr-only">Linear</dt>
                              <dd>
                                {card.linearIssueUrl ? (
                                  <a
                                    href={card.linearIssueUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="font-mono hover:underline"
                                  >
                                    {card.linearIssueId}
                                  </a>
                                ) : (
                                  <span className="font-mono">{card.linearIssueId}</span>
                                )}
                              </dd>
                            </div>
                          ) : null}

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

                          {slackHref ? (
                            <div className="ml-auto">
                              <a
                                href={slackHref}
                                target="_blank"
                                rel="noreferrer"
                                className="hover:underline"
                              >
                                Open Slack thread →
                              </a>
                            </div>
                          ) : null}
                        </dl>
                      </article>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </main>
  );
}
