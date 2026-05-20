"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import type { SessionDetailPageData } from "@/features/sessions/detail/data";
import {
  isTerminalStage,
  stageIndex,
  type PipelineStage,
  type SessionArtifactSummary,
  type SessionDetail,
  type SessionPhaseStatus,
} from "@/features/sessions/types";
import { StatusChip } from "@/components/shared/status-chip";
import { SessionPhaseStatusLabel } from "@/features/sessions/components/session-phase-status-label";
import { SessionWalliePanel } from "@/features/wallie/session-wallie-panel";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { workspaceSessionsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type SessionDetailPageClientProps = {
  initialData: SessionDetailPageData;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

type StageRailEntry = {
  stage: PipelineStage;
  status: "completed" | "current" | "upcoming";
  phaseStatus: SessionPhaseStatus | null;
  completedAt: string | null;
};

function buildStageRail(session: SessionDetail): StageRailEntry[] {
  const completionIndex = new Map(
    session.phaseCompletions.map((c) => [c.stageSlug, c.completedAt]),
  );
  const currentIdx = stageIndex(session.pipeline, session.currentStageSlug);
  return session.pipeline.stages.map((stage, idx) => {
    const completedAt = completionIndex.get(stage.slug) ?? null;
    if (idx < currentIdx || completedAt) {
      return {
        completedAt,
        phaseStatus: null,
        stage,
        status: "completed" as const,
      };
    }
    if (idx === currentIdx) {
      return {
        completedAt: null,
        phaseStatus: session.phaseStatus,
        stage,
        status: "current" as const,
      };
    }
    return {
      completedAt: null,
      phaseStatus: null,
      stage,
      status: "upcoming" as const,
    };
  });
}

export function SessionDetailPageClient({ initialData }: SessionDetailPageClientProps) {
  const router = useRouter();
  const [supabase] = useState<SupabaseClient<Database>>(() => createSupabaseBrowserClient());
  const session = initialData.session;
  const [selectedStageSlug, setSelectedStageSlug] = useState<string>(session.currentStageSlug);
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const stageRail = useMemo(() => buildStageRail(session), [session]);
  const hasConnectionLinks =
    !!session.linearIssueUrl ||
    session.pullRequests.some((pullRequest) => pullRequest.pullRequestUrl);

  const selectedStage = session.pipeline.stages.find((s) => s.slug === selectedStageSlug) ?? null;

  const artifactsByStage = useMemo(() => {
    const map = new Map<string, SessionArtifactSummary[]>();
    for (const artifact of session.artifacts) {
      const list = map.get(artifact.stageSlug) ?? [];
      list.push(artifact);
      map.set(artifact.stageSlug, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.version - a.version);
    }
    return map;
  }, [session.artifacts]);

  const activeArtifacts = artifactsByStage.get(selectedStageSlug) ?? [];
  const latestArtifact = activeArtifacts[0] ?? null;

  const canActOnCurrent =
    selectedStageSlug === session.currentStageSlug && session.phaseStatus === "awaiting_review";

  async function handlePhaseAction(action: "approve" | "reject") {
    if (action === "reject") {
      if (!feedbackDraft.trim()) {
        setActionError("Feedback is required when rejecting.");
        return;
      }
    }

    setActionError(null);

    const response = await fetch(`/api/sessions/${session.id}/phase-action`, {
      body: JSON.stringify({
        action,
        feedbackText: action === "reject" ? feedbackDraft.trim() : undefined,
        version: session.currentArtifactVersion ?? 1,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setActionError(body?.error ?? "Action failed.");
      return;
    }

    setFeedbackDraft("");
    setFeedbackOpen(false);
    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow={
          <Link
            href={workspaceSessionsPath(initialData.workspace.slug)}
            className="hover:text-foreground"
          >
            ← Sessions
          </Link>
        }
        title={session.title}
        actions={session.archivedAt ? <StatusChip tone="planned">Archived</StatusChip> : null}
      />

      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-muted">
        <span className="font-mono">#{session.number}</span>
        {hasConnectionLinks ? (
          <>
            <span aria-hidden="true">·</span>
            <SessionConnections
              linearIssueId={session.linearIssueId}
              linearIssueUrl={session.linearIssueUrl}
              pullRequestCount={session.pullRequestCount}
              pullRequests={session.pullRequests}
            />
          </>
        ) : null}
      </div>

      <div className="mb-6 rounded-[10px] border border-border bg-surface px-5 py-4">
        <StageRail
          stageRail={stageRail}
          selectedStageSlug={selectedStageSlug}
          onSelect={setSelectedStageSlug}
        />
      </div>

      <div className="flex flex-col gap-6">
        <section className="rounded-[8px] border border-border bg-surface">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-[13px] font-semibold text-foreground">
                {selectedStage?.name ?? selectedStageSlug} artifact
              </h2>
              <p className="mt-0.5 text-[11px] text-muted">
                {latestArtifact && canActOnCurrent
                  ? "Review this output before approving."
                  : (selectedStage?.description ?? "")}
              </p>
            </div>
            {selectedStageSlug === session.currentStageSlug ? (
              <SessionPhaseStatusLabel
                status={session.phaseStatus}
                className="shrink-0 text-right text-[11px] leading-4"
              />
            ) : null}
          </div>

          <div className="p-4">
            {latestArtifact ? (
              <ArtifactView artifact={latestArtifact} />
            ) : selectedStageSlug === session.currentStageSlug &&
              session.phaseStatus === "agent_generating" ? (
              <EmptyHint text="Wallie is drafting the artifact for this stage. Refresh in a moment." />
            ) : (
              <EmptyHint
                text={
                  stageIndex(session.pipeline, selectedStageSlug) >
                  stageIndex(session.pipeline, session.currentStageSlug)
                    ? "This stage has not started yet."
                    : "No artifact recorded for this stage."
                }
              />
            )}

            {activeArtifacts.length > 1 ? (
              <details className="mt-4 text-[12px] text-muted">
                <summary className="cursor-pointer hover:text-foreground">
                  {activeArtifacts.length - 1} earlier version
                  {activeArtifacts.length - 1 === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 space-y-2">
                  {activeArtifacts.slice(1).map((artifact) => (
                    <li
                      key={`${artifact.stageSlug}-${artifact.version}`}
                      className="rounded-[4px] border border-border bg-background p-3"
                    >
                      <p className="text-[11px] uppercase text-muted">
                        v{artifact.version} ·{" "}
                        {dateTimeFormatter.format(new Date(artifact.createdAt))}
                      </p>
                      <ArtifactView artifact={artifact} compact />
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>

          {canActOnCurrent ? (
            <div className="border-t border-border bg-surface-muted p-4">
              {actionError ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="mb-3 rounded-[4px] border border-danger/20 bg-danger-soft px-3 py-2 text-[12px] text-danger"
                >
                  {actionError}
                </div>
              ) : null}

              {feedbackOpen ? (
                <div className="space-y-3">
                  <label
                    className="block text-[12px] font-semibold text-foreground"
                    htmlFor="session-feedback"
                  >
                    Feedback for Wallie
                  </label>
                  <textarea
                    id="session-feedback"
                    value={feedbackDraft}
                    onChange={(event) => setFeedbackDraft(event.target.value)}
                    className="ui-textarea min-h-24"
                    placeholder="What should change? Wallie will regenerate this stage."
                  />
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      className="ui-button"
                      onClick={() => {
                        setFeedbackOpen(false);
                        setFeedbackDraft("");
                        setActionError(null);
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={isPending}
                      className="ui-button-primary"
                      onClick={() => handlePhaseAction("reject")}
                    >
                      {isPending ? "Queueing…" : "Queue rerun"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    className="ui-button"
                    disabled={isPending}
                    onClick={() => setFeedbackOpen(true)}
                  >
                    Request changes and rerun
                  </button>
                  <button
                    type="button"
                    className="ui-button-primary"
                    disabled={isPending}
                    onClick={() => handlePhaseAction("approve")}
                  >
                    {isPending
                      ? "Approving…"
                      : isTerminalStage(session.pipeline, session.currentStageSlug)
                        ? "Approve & archive"
                        : "Approve & advance"}
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </section>

        <section className="rounded-[8px] border border-border bg-surface p-4">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Prompt</h2>
          <pre className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground">
            {session.promptMd || "No prompt recorded."}
          </pre>
        </section>

        <section className="rounded-[8px] border border-border bg-surface p-4">
          <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">
            Run activity
          </h2>
          <div className="mt-3">
            <SessionWalliePanel
              initialData={initialData.wallie}
              session={{
                id: session.id,
                workspaceId: session.workspaceId,
              }}
              memberIndex={initialData.memberIndex}
              supabase={supabase}
              workspaceSlug={initialData.workspace.slug}
            />
          </div>
        </section>
      </div>
    </PageContainer>
  );
}

function StageRail({
  onSelect,
  stageRail,
  selectedStageSlug,
}: {
  onSelect: (stageSlug: string) => void;
  stageRail: StageRailEntry[];
  selectedStageSlug: string;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {stageRail.map((entry, index) => {
        const isSelected = entry.stage.slug === selectedStageSlug;
        return (
          <li key={entry.stage.id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelect(entry.stage.slug)}
              className={cn(
                "group flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
                isSelected
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-border bg-surface text-foreground hover:bg-surface-muted",
              )}
              aria-current={isSelected ? "step" : undefined}
            >
              <StageDot entry={entry} />
              <span>{entry.stage.name}</span>
            </button>
            {index < stageRail.length - 1 ? (
              <span aria-hidden="true" className="h-px w-4 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function StageDot({ entry }: { entry: StageRailEntry }) {
  let className = "h-2 w-2 rounded-full";
  if (entry.status === "completed") {
    className = cn(className, "bg-success");
  } else if (entry.status === "upcoming") {
    className = cn(className, "bg-surface-muted border border-border");
  } else if (entry.phaseStatus === "rejected") {
    className = cn(className, "bg-danger");
  } else if (entry.phaseStatus === "approved") {
    className = cn(className, "bg-success");
  } else if (entry.phaseStatus === "agent_generating") {
    className = cn(className, "bg-accent animate-pulse");
  } else {
    className = cn(className, "bg-accent");
  }
  return <span className={className} aria-hidden="true" />;
}

function ArtifactView({
  artifact,
  compact = false,
}: {
  artifact: SessionArtifactSummary;
  compact?: boolean;
}) {
  const formatted = useMemo(() => {
    if (typeof artifact.payload === "string") {
      return artifact.payload;
    }
    try {
      return JSON.stringify(artifact.payload, null, 2);
    } catch {
      return String(artifact.payload);
    }
  }, [artifact.payload]);

  const isMarkdown = typeof artifact.payload === "string";

  return (
    <div>
      {!compact ? (
        <p className="mb-2 text-[11px] uppercase tracking-wide text-muted">
          v{artifact.version} · {dateTimeFormatter.format(new Date(artifact.createdAt))}
        </p>
      ) : null}
      <pre
        className={`max-h-[480px] overflow-auto rounded-[4px] p-3 text-[12px] leading-5 text-foreground ${isMarkdown ? "whitespace-pre-wrap" : "bg-background"}`}
      >
        {formatted}
      </pre>
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="rounded-[4px] border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted">
      {text}
    </p>
  );
}
