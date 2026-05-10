"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { SessionConnections } from "@/features/sessions/components/session-connections";
import type { SessionDetailPageData } from "@/features/sessions/detail/data";
import {
  formatSessionPhaseStatus,
  isTerminalStage,
  sessionPhaseStatusTone,
  stageIndex,
  type PipelineStage,
  type SessionArtifactSummary,
  type SessionDetail,
  type SessionPhaseStatus,
  type SessionRun,
} from "@/features/sessions/types";
import { StatusChip } from "@/components/shared/status-chip";
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
    <main className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <Link
              href={workspaceSessionsPath(initialData.workspace.slug)}
              className="text-[11px] font-medium uppercase tracking-wide text-muted hover:text-foreground"
            >
              ← Sessions
            </Link>
            <div className="mt-2 flex items-center gap-3">
              <span className="font-mono text-[12px] text-muted">#{session.number}</span>
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                {session.title}
              </h1>
              {session.archivedAt ? <StatusChip tone="planned">Archived</StatusChip> : null}
            </div>
            <div className="mt-3">
              <SessionConnections
                linearIssueId={session.linearIssueId}
                linearIssueUrl={session.linearIssueUrl}
                pullRequestCount={session.pullRequestCount}
                pullRequests={session.pullRequests}
                slackChannelId={session.slackChannelId}
                slackThreadTs={session.slackThreadTs}
              />
            </div>
          </div>
        </div>
      </header>

      <section className="border-b border-border px-6 py-5">
        <StageRail
          stageRail={stageRail}
          selectedStageSlug={selectedStageSlug}
          onSelect={setSelectedStageSlug}
        />
      </section>

      <div className="flex flex-1 flex-col gap-6 overflow-auto px-6 py-6 md:flex-row">
        <div className="flex min-w-0 flex-[2] flex-col gap-4">
          <div className="rounded-[8px] border border-border bg-surface">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-[13px] font-semibold text-foreground">
                  {selectedStage?.name ?? selectedStageSlug} stage
                </h2>
                <p className="mt-0.5 text-[11px] text-muted">{selectedStage?.description ?? ""}</p>
              </div>
              {selectedStageSlug === session.currentStageSlug ? (
                <StatusChip tone={sessionPhaseStatusTone(session.phaseStatus)}>
                  {formatSessionPhaseStatus(session.phaseStatus)}
                </StatusChip>
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
                        {isPending ? "Submitting…" : "Submit feedback"}
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
                      Request changes
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
          </div>

          <div className="rounded-[8px] border border-border bg-surface p-4">
            <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">
              Wallie agent
            </h2>
            <div className="mt-3">
              <SessionWalliePanel
                initialData={initialData.wallie}
                session={{
                  githubRepositoryId: initialData.sessionGithubRepositoryId,
                  id: session.id,
                  workspaceId: session.workspaceId,
                }}
                memberIndex={initialData.memberIndex}
                repositories={initialData.wallie.repository ? [initialData.wallie.repository] : []}
                supabase={supabase}
                workspaceSlug={initialData.workspace.slug}
              />
            </div>
          </div>
        </div>

        <aside className="flex w-full flex-col gap-4 md:w-[320px]">
          <section className="rounded-[8px] border border-border bg-surface p-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Prompt</h3>
            <pre className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-foreground">
              {session.promptMd || "No prompt recorded."}
            </pre>
          </section>

          <section className="rounded-[8px] border border-border bg-surface p-4">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted">
              Run history
            </h3>
            {session.runHistory.length === 0 ? (
              <p className="mt-2 text-[11px] text-muted">No agent runs yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {session.runHistory.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </main>
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
              {entry.status === "current" && entry.phaseStatus ? (
                <span className="text-[10px] text-muted">
                  {formatSessionPhaseStatus(entry.phaseStatus)}
                </span>
              ) : null}
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
  } else if (entry.phaseStatus === "rejected" || entry.phaseStatus === "escalated") {
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

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function RunRow({ run }: { run: SessionRun }) {
  const hasTokens = run.inputTokens !== null || run.outputTokens !== null;

  return (
    <li className="rounded-[4px] border border-border bg-background px-2.5 py-1.5 text-[11px]">
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-foreground">{run.runType}</span>
          <span className="text-muted">{dateTimeFormatter.format(new Date(run.createdAt))}</span>
        </div>
        <span className="text-muted">{run.status}</span>
      </div>
      {hasTokens ? (
        <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
          {run.inputTokens !== null ? <span>{formatTokenCount(run.inputTokens)} in</span> : null}
          {run.outputTokens !== null ? <span>{formatTokenCount(run.outputTokens)} out</span> : null}
          {run.totalCostUsd !== null ? <span>${run.totalCostUsd.toFixed(4)}</span> : null}
        </div>
      ) : null}
    </li>
  );
}
