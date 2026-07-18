"use client";

import Link from "next/link";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PAGE_HEADER_TITLE_CLASS, PageContainer, PageHeader } from "@/components/ui/page-shell";
import { ArchiveIcon, CheckIcon, PencilIcon, XIcon } from "@/components/shared/icons";
import { Spinner } from "@/components/shared/spinner";
import {
  archiveSessionFromClient,
  unarchiveSessionFromClient,
  updateSessionTitleFromClient,
} from "@/features/sessions/client";
import { SessionConnections } from "@/features/sessions/components/session-connections";
import { ArtifactPanel } from "@/features/sessions/detail/artifact-panel";
import { SessionActivityArchivedAtProvider } from "@/features/sessions/detail/session-activity-client";
import type {
  SessionReviewData,
  SessionReviewPipeline,
  SessionReviewSession,
  SessionReviewStage,
} from "@/features/sessions/detail/data";
import {
  mergeArtifactRealtimeRow,
  mergeCompletionRealtimeRow,
  mergeSessionRealtimeRow,
} from "@/features/sessions/detail/realtime";
import type { SessionArtifactSummary, SessionPhaseStatus } from "@/features/sessions/types";
import { StatusChip } from "@/components/shared/status-chip";
import { SessionPhaseStatusLabel } from "@/features/sessions/components/session-phase-status-label";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { workspaceSessionsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type SessionDetailPageClientProps = {
  activity: ReactNode;
  initialData: SessionReviewData;
  initialFormattedArtifact: ReactNode | null;
  initialFormattedArtifactKey: string | null;
};

const dateTimeFormatOptions: Intl.DateTimeFormatOptions = {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
};

const fullDateTimeFormatOptions: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, dateTimeFormatOptions);

const fullDateTimeFormatter = new Intl.DateTimeFormat(undefined, fullDateTimeFormatOptions);

// Deterministic formatters (fixed locale + UTC) for the initial server render.
// `Intl.DateTimeFormat(undefined, …)` resolves to the environment timezone —
// UTC on Vercel, local in the browser — so an always-visible absolute date
// would mismatch on hydration and could even show the wrong calendar day near
// midnight UTC. We render these UTC-pinned values during SSR/first paint, then
// swap to the viewer's local formatters after mount (see `mounted` below).
const ssrDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  ...dateTimeFormatOptions,
  timeZone: "UTC",
});

const ssrFullDateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  ...fullDateTimeFormatOptions,
  timeZone: "UTC",
});

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

function CreatorAvatar({ displayName }: { displayName: string }) {
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-surface-strong type-annotation font-semibold text-foreground"
    >
      {initial}
    </span>
  );
}

type StageRailEntry = {
  stage: SessionReviewStage;
  status: "completed" | "current" | "upcoming";
  phaseStatus: SessionPhaseStatus | null;
  completedAt: string | null;
};

function stageIndex(pipeline: SessionReviewPipeline, stageSlug: string): number {
  return pipeline.stages.findIndex((stage) => stage.slug === stageSlug);
}

function isTerminalStage(pipeline: SessionReviewPipeline, stageSlug: string): boolean {
  const terminalStage = pipeline.stages[pipeline.stages.length - 1];
  return terminalStage?.slug === stageSlug;
}

function buildStageRail(session: SessionReviewSession): StageRailEntry[] {
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

export function SessionDetailPageClient({
  activity,
  initialData,
  initialFormattedArtifact,
  initialFormattedArtifactKey,
}: SessionDetailPageClientProps) {
  const router = useRouter();
  const [supabase] = useState<SupabaseClient<Database>>(() => createSupabaseBrowserClient());
  const [session, setSession] = useState(initialData.session);
  const creatorDisplayName = initialData.creatorDisplayName;
  const [selectedStageSlug, setSelectedStageSlug] = useState<string>(
    initialData.session.currentStageSlug,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [phaseActionPending, setPhaseActionPending] = useState<"approve" | "reject" | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Gate locale/timezone-sensitive timestamps so the absolute "Created" date
  // renders identically on the server and during the first client paint, then
  // re-renders in the viewer's local timezone once mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const createdAtDate = new Date(session.createdAt);
  const createdAtLabel = (mounted ? dateTimeFormatter : ssrDateTimeFormatter).format(createdAtDate);
  const createdAtFull = (mounted ? fullDateTimeFormatter : ssrFullDateTimeFormatter).format(
    createdAtDate,
  );

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
  const selectedStageIsCurrent = selectedStageSlug === session.currentStageSlug;
  const selectedStagePosition = stageIndex(session.pipeline, selectedStageSlug);
  const currentStagePosition = stageIndex(session.pipeline, session.currentStageSlug);
  const shouldLoadLatestArtifact =
    selectedStagePosition < currentStagePosition ||
    (selectedStageIsCurrent && (session.currentArtifactVersion ?? 0) > 0);
  const isDraftingSelectedStage =
    selectedStageIsCurrent && session.phaseStatus === "agent_generating" && !session.archivedAt;

  const canActOnCurrent =
    selectedStageIsCurrent && session.phaseStatus === "awaiting_review" && !session.archivedAt;
  const phaseActionBusy = phaseActionPending !== null || isPending;

  useEffect(() => {
    setSession(initialData.session);
    setSelectedStageSlug((currentSlug) => {
      const stageStillExists = initialData.session.pipeline.stages.some(
        (stage) => stage.slug === currentSlug,
      );

      return stageStillExists ? currentSlug : initialData.session.currentStageSlug;
    });
  }, [initialData.session]);

  const handleSessionRealtimeUpdate = useEffectEvent((row: Tables<"sessions">) => {
    let previousCurrentStageSlug: string | null = null;
    let nextCurrentStageSlug: string | null = null;

    setSession((currentSession) => {
      previousCurrentStageSlug = currentSession.currentStageSlug;
      const nextSession = mergeSessionRealtimeRow(currentSession, row);

      nextCurrentStageSlug = nextSession.currentStageSlug;
      return nextSession;
    });

    setSelectedStageSlug((currentSlug) =>
      previousCurrentStageSlug && nextCurrentStageSlug && currentSlug === previousCurrentStageSlug
        ? nextCurrentStageSlug
        : currentSlug,
    );
  });

  const handleArtifactRealtimeUpdate = useEffectEvent((row: Tables<"session_artifacts">) => {
    setSession((currentSession) => mergeArtifactRealtimeRow(currentSession, row));
  });

  const handleCompletionRealtimeUpdate = useEffectEvent(
    (row: Tables<"session_phase_completions">) => {
      setSession((currentSession) => mergeCompletionRealtimeRow(currentSession, row));
    },
  );

  const refreshSessionFromServer = useEffectEvent(() => {
    startTransition(() => {
      router.refresh();
    });
  });

  useEffect(() => {
    const channel = supabase
      .channel(`session-detail:${session.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `id=eq.${session.id}`,
          schema: "public",
          table: "sessions",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            refreshSessionFromServer();
            return;
          }

          handleSessionRealtimeUpdate(payload.new as Tables<"sessions">);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `session_id=eq.${session.id}`,
          schema: "public",
          table: "session_artifacts",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            refreshSessionFromServer();
            return;
          }

          handleArtifactRealtimeUpdate(payload.new as Tables<"session_artifacts">);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `session_id=eq.${session.id}`,
          schema: "public",
          table: "session_phase_completions",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            refreshSessionFromServer();
            return;
          }

          handleCompletionRealtimeUpdate(payload.new as Tables<"session_phase_completions">);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `session_id=eq.${session.id}`,
          schema: "public",
          table: "session_pull_requests",
        },
        () => {
          refreshSessionFromServer();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [session.id, supabase]);

  async function handlePhaseAction(action: "approve" | "reject") {
    if (action === "reject") {
      if (!feedbackDraft.trim()) {
        setActionError("Feedback is required when rejecting.");
        return;
      }
    }

    setActionError(null);
    setPhaseActionPending(action);

    try {
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
    } finally {
      setPhaseActionPending(null);
    }
  }

  function handleTitleSaved(nextTitle: string) {
    setSession((currentSession) => ({ ...currentSession, title: nextTitle }));
    startTransition(() => {
      router.refresh();
    });
  }

  async function handleStopRun() {
    setActionError(null);
    setStopPending(true);

    try {
      const response = await fetch(`/api/sessions/${session.id}/cancel`, {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setActionError(body?.error ?? "Could not stop the run.");
        return;
      }

      startTransition(() => {
        router.refresh();
      });
    } finally {
      setStopPending(false);
    }
  }

  async function handleArchive() {
    setArchiveError(null);
    setArchivePending(true);

    try {
      const result = await archiveSessionFromClient({ sessionId: session.id });
      setArchiveConfirming(false);
      // Flip the header immediately; router.refresh() + realtime reconcile the
      // parked phase_status.
      setSession((current) => ({ ...current, archivedAt: result.archivedAt }));
      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Failed to archive session.");
    } finally {
      setArchivePending(false);
    }
  }

  async function handleUnarchive() {
    setArchiveError(null);
    setArchivePending(true);

    try {
      const result = await unarchiveSessionFromClient({ sessionId: session.id });
      setSession((current) => ({ ...current, archivedAt: result.archivedAt }));
      startTransition(() => {
        router.refresh();
      });
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Failed to unarchive session.");
    } finally {
      setArchivePending(false);
    }
  }

  const headerActions = session.archivedAt ? (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <StatusChip tone="planned">Archived</StatusChip>
        <button
          type="button"
          className="ui-button gap-1.5"
          disabled={archivePending}
          onClick={() => void handleUnarchive()}
        >
          {archivePending ? (
            <>
              <Spinner />
              <span>Unarchiving…</span>
            </>
          ) : (
            "Unarchive"
          )}
        </button>
      </div>
      {archiveError ? (
        <span className="text-xs text-danger" role="alert">
          {archiveError}
        </span>
      ) : null}
    </div>
  ) : (
    <div className="flex flex-col items-end gap-1">
      {archiveConfirming ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Archive this session?</span>
          <button
            type="button"
            className="ui-button-danger gap-1.5"
            disabled={archivePending}
            onClick={() => void handleArchive()}
          >
            {archivePending ? (
              <>
                <Spinner />
                <span>Archiving…</span>
              </>
            ) : (
              "Confirm"
            )}
          </button>
          <button
            type="button"
            className="ui-button"
            disabled={archivePending}
            onClick={() => {
              setArchiveConfirming(false);
              setArchiveError(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="ui-button gap-1.5"
          onClick={() => {
            setArchiveConfirming(true);
            setArchiveError(null);
          }}
        >
          <ArchiveIcon className="h-3.5 w-3.5" />
          <span>Archive</span>
        </button>
      )}
      {archiveError ? (
        <span className="text-xs text-danger" role="alert">
          {archiveError}
        </span>
      ) : null}
    </div>
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <Link
              href={workspaceSessionsPath(initialData.workspaceSlug)}
              className="hover:text-foreground"
            >
              ← Sessions
            </Link>
            <span aria-hidden="true" className="text-muted/60">
              /
            </span>
            <span className="font-mono tracking-normal">#{session.number}</span>
          </span>
        }
        titleAsChild
        title={
          <EditableSessionTitle
            onTitleSaved={handleTitleSaved}
            sessionId={session.id}
            sessionNumber={session.number}
            title={session.title}
          />
        }
        actions={headerActions}
      />

      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
        {creatorDisplayName ? (
          <>
            <span className="inline-flex items-center gap-1.5">
              <CreatorAvatar displayName={creatorDisplayName} />
              <span className="text-foreground">{creatorDisplayName}</span>
            </span>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <span title={createdAtFull} suppressHydrationWarning>
          Created {createdAtLabel}
        </span>
        <span aria-hidden="true">·</span>
        {/* Relative time derives from Date.now(), which differs between the
            server render and hydration; suppress the resulting text mismatch
            (the label is approximate by nature). */}
        <span
          title={fullDateTimeFormatter.format(new Date(session.updatedAt))}
          suppressHydrationWarning
        >
          Updated {relativeTime(session.updatedAt)}
        </span>
        {hasConnectionLinks ? (
          <>
            <span aria-hidden="true">·</span>
            <SessionConnections
              linearIssueId={session.linearIssueId}
              linearIssueUrl={session.linearIssueUrl}
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
          <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold text-foreground">
                {selectedStage?.name ?? selectedStageSlug} artifact
              </h2>
              <p className="mt-0.5 type-annotation text-muted">
                {latestArtifact && canActOnCurrent
                  ? "Review this output before approving."
                  : (selectedStage?.description ?? "")}
              </p>
            </div>
            {selectedStageSlug === session.currentStageSlug ? (
              <SessionPhaseStatusLabel
                status={session.phaseStatus}
                className="shrink-0 type-annotation leading-4 sm:text-right"
              />
            ) : null}
          </div>

          <div aria-busy={isDraftingSelectedStage} aria-live="polite" className="p-4">
            <ArtifactPanel
              emptyText={
                selectedStagePosition > currentStagePosition
                  ? "This stage has not started yet."
                  : "No artifact recorded for this stage."
              }
              initialFormattedArtifact={initialFormattedArtifact}
              initialFormattedArtifactKey={initialFormattedArtifactKey}
              isDrafting={isDraftingSelectedStage}
              latestArtifact={latestArtifact}
              loadLatest={shouldLoadLatestArtifact}
              sessionId={session.id}
              stageSlug={selectedStageSlug}
            />
          </div>

          {isDraftingSelectedStage ? (
            <div className="border-t border-border bg-surface-muted p-4">
              {actionError ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="mb-3 rounded-[4px] border border-danger/20 bg-danger-soft px-3 py-2 text-xs text-danger"
                >
                  {actionError}
                </div>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
                <button
                  type="button"
                  className="ui-button-danger gap-1.5"
                  disabled={stopPending}
                  onClick={() => void handleStopRun()}
                >
                  {stopPending ? (
                    <>
                      <Spinner />
                      <span>Stopping…</span>
                    </>
                  ) : (
                    "Stop run"
                  )}
                </button>
              </div>
            </div>
          ) : null}

          {canActOnCurrent ? (
            <div className="border-t border-border bg-surface-muted p-4">
              {actionError ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="mb-3 rounded-[4px] border border-danger/20 bg-danger-soft px-3 py-2 text-xs text-danger"
                >
                  {actionError}
                </div>
              ) : null}

              {feedbackOpen ? (
                <div className="space-y-3">
                  <label
                    className="block text-xs font-semibold text-foreground"
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
                  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
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
                      disabled={phaseActionBusy}
                      className="ui-button-primary gap-1.5"
                      onClick={() => handlePhaseAction("reject")}
                    >
                      {phaseActionPending === "reject" ? (
                        <>
                          <Spinner />
                          <span>Queueing…</span>
                        </>
                      ) : (
                        "Queue rerun"
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                  <button
                    type="button"
                    className="ui-button"
                    disabled={phaseActionBusy}
                    onClick={() => setFeedbackOpen(true)}
                  >
                    Request changes and rerun
                  </button>
                  <button
                    type="button"
                    className="ui-button-primary gap-1.5"
                    disabled={phaseActionBusy}
                    onClick={() => handlePhaseAction("approve")}
                  >
                    {phaseActionPending === "approve" ? (
                      <>
                        <Spinner />
                        <span>Approving…</span>
                      </>
                    ) : isTerminalStage(session.pipeline, session.currentStageSlug) ? (
                      "Approve & archive"
                    ) : (
                      "Approve & advance"
                    )}
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </section>

        <section className="rounded-[8px] border border-border bg-surface p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Prompt</h2>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
            {session.promptMd || "No prompt recorded."}
          </pre>
        </section>

        <section className="rounded-[8px] border border-border bg-surface p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Run activity</h2>
          <div className="mt-3">
            <SessionActivityArchivedAtProvider archivedAt={session.archivedAt}>
              {activity}
            </SessionActivityArchivedAtProvider>
          </div>
        </section>
      </div>
    </PageContainer>
  );
}

function EditableSessionTitle({
  onTitleSaved,
  sessionId,
  sessionNumber,
  title,
}: {
  onTitleSaved: (title: string) => void;
  sessionId: string;
  sessionNumber: number;
  title: string;
}) {
  const [draftTitle, setDraftTitle] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isEditing) return;
    editInputRef.current?.focus();
    editInputRef.current?.select();
  }, [isEditing]);

  function startEditing() {
    setDraftTitle(title);
    setError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    setDraftTitle(title);
    setError(null);
    setIsEditing(false);
  }

  async function saveTitle() {
    if (isSaving) return;

    const normalizedTitle = draftTitle.trim();

    if (!normalizedTitle) {
      setError("Title is required.");
      return;
    }

    if (normalizedTitle === title) {
      setError(null);
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const result = await updateSessionTitleFromClient({
        sessionId,
        title: normalizedTitle,
      });
      setIsEditing(false);
      onTitleSaved(result.title);
    } catch (errorValue) {
      setError(
        errorValue instanceof Error ? errorValue.message : "Failed to update session title.",
      );
    } finally {
      setIsSaving(false);
    }
  }

  if (isEditing) {
    return (
      <div className="flex flex-col gap-2">
        {/* Keep a stable heading name for assistive tech while the visible title is an input. */}
        <h1 className="sr-only">{title}</h1>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            ref={editInputRef}
            aria-label={`Session #${sessionNumber} title`}
            className="ui-input h-11 min-w-0 flex-1 px-3 py-1.5 text-[20px] font-semibold sm:text-[22px]"
            disabled={isSaving}
            value={draftTitle}
            onChange={(event) => {
              setDraftTitle(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void saveTitle();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEditing();
              }
            }}
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="ui-icon-button h-9 w-9 text-accent"
              aria-label={`Save title for session #${sessionNumber}`}
              title="Save title"
              disabled={isSaving}
              onClick={() => void saveTitle()}
            >
              {isSaving ? (
                <Spinner className="h-4 w-4" label="Saving title" />
              ) : (
                <CheckIcon className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              className="ui-icon-button h-9 w-9"
              aria-label={`Cancel title edit for session #${sessionNumber}`}
              title="Cancel title edit"
              disabled={isSaving}
              onClick={cancelEditing}
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        {error ? (
          <p className="text-xs leading-4 text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <h1 className={cn(PAGE_HEADER_TITLE_CLASS, "min-w-0")}>{title}</h1>
      <button
        type="button"
        className="ui-icon-button h-8 w-8 shrink-0"
        aria-label={`Edit title for session #${sessionNumber}`}
        title="Edit title"
        onClick={startEditing}
      >
        <PencilIcon className="h-4 w-4" />
      </button>
    </div>
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
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    buttonRefs.current.get(selectedStageSlug)?.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }, [selectedStageSlug]);

  return (
    <ol className="flex snap-x items-center gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
      {stageRail.map((entry, index) => {
        const isSelected = entry.stage.slug === selectedStageSlug;
        return (
          <li key={entry.stage.id} className="flex shrink-0 snap-start items-center gap-2">
            <button
              ref={(node) => {
                if (node) {
                  buttonRefs.current.set(entry.stage.slug, node);
                } else {
                  buttonRefs.current.delete(entry.stage.slug);
                }
              }}
              type="button"
              onClick={() => onSelect(entry.stage.slug)}
              className={cn(
                "group flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
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
              <span aria-hidden="true" className="hidden h-px w-4 bg-border sm:block" />
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
