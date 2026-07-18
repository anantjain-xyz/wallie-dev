"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PAGE_HEADER_TITLE_CLASS, PageContainer, PageHeader } from "@/components/ui/page-shell";
import { ArchiveIcon, CheckIcon, PencilIcon, XIcon } from "@/components/shared/icons";
import { Spinner } from "@/components/shared/spinner";
import { TimeDisplay } from "@/components/shared/time-display";
import { VisibleInteractionBoundary } from "@/components/telemetry/visible-interaction-boundary";
import { Status, sessionPhaseStatusValue, type StatusValue } from "@/components/ui/status";
import {
  archiveSessionFromClient,
  isSessionPhaseMutationResult,
  loadSessionStateFromClient,
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
import type {
  SessionMutationStage,
  SessionPhaseMutationResult,
} from "@/features/sessions/mutation-contracts";
import {
  mergeArtifactRealtimeRow,
  mergeCompletionRealtimeRow,
  mergeSessionRealtimeRow,
  removeArtifactRealtimeRow,
  removeCompletionRealtimeRow,
  removePullRequestRealtimeRow,
} from "@/features/sessions/detail/realtime";
import {
  applySessionMutationPatch,
  compareSessionTimestamps,
  reconcileSessionMutationPatch,
  rollbackSessionMutationPatch,
  runOptimisticMutation,
  type SessionMutationPatch,
} from "@/features/sessions/optimistic";
import type { SessionArtifactSummary, SessionPhaseStatus } from "@/features/sessions/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { workspaceSessionsPath } from "@/lib/routes";
import { finishInteraction, startInteraction } from "@/lib/telemetry/interaction-rum";
import { cn } from "@/lib/utils";

type SessionDetailPageClientProps = {
  activity: ReactNode;
  initialData: SessionReviewData;
  initialFormattedArtifact: ReactNode | null;
  initialFormattedArtifactKey: string | null;
  initialNow?: string;
};

function CreatorAvatar({ displayName }: { displayName: string }) {
  const initial = displayName.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-control-hover type-annotation font-semibold text-foreground"
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

function mergeSessionReviewStage(
  session: SessionReviewSession,
  stage: SessionMutationStage,
): SessionReviewSession {
  const existingStage = session.pipeline.stages.find((current) => current.id === stage.id);
  if (
    existingStage?.description === stage.description &&
    existingStage.name === stage.name &&
    existingStage.position === stage.position &&
    existingStage.slug === stage.slug
  ) {
    return session;
  }

  const stages = session.pipeline.stages
    .filter((current) => current.id !== stage.id)
    .concat(stage)
    .sort((left, right) => left.position - right.position);

  return { ...session, pipeline: { stages } };
}

export function reconcilePhaseMutationResult(
  session: SessionReviewSession,
  result: SessionPhaseMutationResult,
): SessionReviewSession {
  return reconcileSessionMutationPatch(mergeSessionReviewStage(session, result.currentStage), {
    archivedAt: result.archivedAt,
    currentArtifactVersion: result.artifactVersion,
    currentStageId: result.currentStageId,
    phaseStatus: result.phaseStatus,
    rejectionCount: result.rejectionCount,
    updatedAt: result.updatedAt,
  });
}

export function SessionDetailPageClient({
  activity,
  initialData,
  initialFormattedArtifact,
  initialFormattedArtifactKey,
  initialNow,
}: SessionDetailPageClientProps) {
  const renderNow = initialNow ?? "1970-01-01T00:00:00.000Z";
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
  const [archivePending, setArchivePending] = useState<"archive" | "unarchive" | null>(null);
  const [archiveConfirming, setArchiveConfirming] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const pullRequestUpdatedAtRef = useRef(new Map<string, string>());

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
    selectedStageIsCurrent &&
    (session.phaseStatus === "agent_generating" || stopPending) &&
    !session.archivedAt;

  const canActOnCurrent =
    selectedStageIsCurrent &&
    (session.phaseStatus === "awaiting_review" || phaseActionPending !== null) &&
    !session.archivedAt;
  const phaseActionBusy = phaseActionPending !== null;
  const canStopRun = isDraftingSelectedStage && !phaseActionBusy;

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
    const stageIsKnown = session.pipeline.stages.some((stage) => stage.id === row.current_stage_id);
    if (!stageIsKnown && compareSessionTimestamps(row.updated_at, session.updatedAt) >= 0) {
      const previousCurrentStageSlug = session.currentStageSlug;
      void loadSessionStateFromClient({ sessionId: session.id })
        .then((result) => {
          setSession((current) => reconcilePhaseMutationResult(current, result));
          setSelectedStageSlug((currentSlug) =>
            currentSlug === previousCurrentStageSlug ? result.currentStage.slug : currentSlug,
          );
        })
        .catch((error) => {
          setActionError(
            error instanceof Error ? error.message : "Could not reconcile the updated stage.",
          );
        });
      return;
    }

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
            router.replace(workspaceSessionsPath(initialData.workspaceSlug));
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
            const deleted = payload.old as Pick<Tables<"session_artifacts">, "id"> &
              Partial<Pick<Tables<"session_artifacts">, "stage_slug" | "version">>;
            setSession((current) => removeArtifactRealtimeRow(current, deleted));
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
            const deleted = payload.old as Pick<Tables<"session_phase_completions">, "id"> &
              Partial<Pick<Tables<"session_phase_completions">, "stage_slug">>;
            setSession((current) => removeCompletionRealtimeRow(current, deleted));
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
        (payload) => {
          const row = (payload.eventType === "DELETE" ? payload.old : payload.new) as Pick<
            Tables<"session_pull_requests">,
            "id" | "pull_request_number" | "pull_request_url" | "updated_at"
          >;
          setSession((current) => {
            const existing = current.pullRequests.find((pullRequest) => pullRequest.id === row.id);

            if (payload.eventType === "DELETE") {
              pullRequestUpdatedAtRef.current.delete(row.id);
              return removePullRequestRealtimeRow(current, row);
            }

            const previousUpdatedAt = pullRequestUpdatedAtRef.current.get(row.id);
            if (
              previousUpdatedAt &&
              compareSessionTimestamps(row.updated_at, previousUpdatedAt) <= 0
            ) {
              return current;
            }

            const pullRequests = current.pullRequests.filter(
              (pullRequest) => pullRequest.id !== row.id,
            );
            pullRequestUpdatedAtRef.current.set(row.id, row.updated_at);
            if (
              existing?.pullRequestNumber === row.pull_request_number &&
              existing.pullRequestUrl === row.pull_request_url
            ) {
              return current;
            }

            pullRequests.push({
              id: row.id,
              pullRequestNumber: row.pull_request_number,
              pullRequestUrl: row.pull_request_url,
            });

            return { ...current, pullRequests };
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [initialData.workspaceSlug, router, session.id, supabase]);

  async function handlePhaseAction(action: "approve" | "reject") {
    if (action === "reject") {
      if (!feedbackDraft.trim()) {
        setActionError("Feedback is required when rejecting.");
        return;
      }
    }

    setActionError(null);
    setPhaseActionPending(action);
    startInteraction(action, "/w/[workspaceSlug]/sessions/[sessionNumber]");

    const previousStageSlug = session.currentStageSlug;
    const previousPatch: SessionMutationPatch = {
      archivedAt: session.archivedAt,
      currentArtifactVersion: session.currentArtifactVersion,
      currentStageId: session.currentStageId,
      phaseStatus: session.phaseStatus,
      rejectionCount: session.rejectionCount ?? 0,
      updatedAt: session.updatedAt,
    };
    const nextStage =
      action === "approve"
        ? session.pipeline.stages[stageIndex(session.pipeline, session.currentStageSlug) + 1]
        : null;
    const optimisticCompletion = {
      completedAt: new Date().toISOString(),
      stageSlug: session.currentStageSlug,
    };
    const optimisticPhaseCompletions = [
      ...session.phaseCompletions.filter(
        (completion) => completion.stageSlug !== session.currentStageSlug,
      ),
      optimisticCompletion,
    ];
    if (action === "approve") {
      previousPatch.phaseCompletions = session.phaseCompletions;
    }
    const optimisticPatch: SessionMutationPatch =
      action === "reject"
        ? { phaseStatus: "rejected", rejectionCount: (session.rejectionCount ?? 0) + 1 }
        : nextStage
          ? {
              currentArtifactVersion: 0,
              currentStageId: nextStage.id,
              phaseCompletions: optimisticPhaseCompletions,
              phaseStatus: "agent_generating",
              rejectionCount: 0,
            }
          : {
              archivedAt: new Date().toISOString(),
              phaseCompletions: optimisticPhaseCompletions,
              phaseStatus: "approved",
            };

    try {
      await runOptimisticMutation({
        optimistic: () => {
          setSession((current) => applySessionMutationPatch(current, optimisticPatch));
          if (nextStage) setSelectedStageSlug(nextStage.slug);
        },
        mutate: async () => {
          const response = await fetch(`/api/sessions/${session.id}/phase-action`, {
            body: JSON.stringify({
              action,
              feedbackText: action === "reject" ? feedbackDraft.trim() : undefined,
              version: session.currentArtifactVersion ?? 1,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          const body = (await response.json().catch(() => null)) as
            | (Partial<SessionPhaseMutationResult> & { error?: string })
            | null;

          if (!response.ok) throw new Error(body?.error ?? "Action failed.");
          if (!isSessionPhaseMutationResult(body)) {
            throw new Error("Action response was invalid.");
          }
          return body;
        },
        commit: (result) => {
          setSession((current) => reconcilePhaseMutationResult(current, result));
          setSelectedStageSlug((currentSlug) =>
            currentSlug === previousStageSlug ? result.currentStage.slug : currentSlug,
          );
        },
        rollback: () => {
          setSession((current) =>
            rollbackSessionMutationPatch(current, optimisticPatch, previousPatch),
          );
          if (nextStage) {
            setSelectedStageSlug((currentSlug) =>
              currentSlug === nextStage.slug ? previousStageSlug : currentSlug,
            );
          }
        },
      });

      setFeedbackDraft("");
      setFeedbackOpen(false);
      finishInteraction(action, "success");
    } catch (error) {
      finishInteraction(action, "error");
      setActionError(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setPhaseActionPending(null);
    }
  }

  function handleTitleChanged(nextTitle: string, updatedAt?: string, expectedTitle?: string) {
    setSession((currentSession) => {
      if (expectedTitle !== undefined && currentSession.title !== expectedTitle) {
        return currentSession;
      }
      return updatedAt
        ? reconcileSessionMutationPatch(currentSession, { title: nextTitle, updatedAt })
        : applySessionMutationPatch(currentSession, { title: nextTitle });
    });
  }

  async function handleStopRun() {
    if (phaseActionPending !== null || stopPending) return;
    setActionError(null);
    setStopPending(true);
    const optimisticPatch: SessionMutationPatch = { phaseStatus: "rejected" };
    const previousPatch: SessionMutationPatch = {
      phaseStatus: session.phaseStatus,
      updatedAt: session.updatedAt,
    };

    try {
      await runOptimisticMutation({
        optimistic: () =>
          setSession((current) => applySessionMutationPatch(current, optimisticPatch)),
        mutate: async () => {
          const response = await fetch(`/api/sessions/${session.id}/cancel`, {
            headers: { "Content-Type": "application/json" },
            method: "POST",
          });
          const body = (await response.json().catch(() => null)) as
            | (Partial<SessionPhaseMutationResult> & { error?: string })
            | null;
          if (!response.ok) throw new Error(body?.error ?? "Could not stop the run.");
          if (!isSessionPhaseMutationResult(body)) {
            throw new Error("Stop response was invalid.");
          }
          return body;
        },
        commit: (result) => setSession((current) => reconcilePhaseMutationResult(current, result)),
        rollback: () =>
          setSession((current) =>
            rollbackSessionMutationPatch(current, optimisticPatch, previousPatch),
          ),
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not stop the run.");
    } finally {
      setStopPending(false);
    }
  }

  async function handleArchive() {
    setArchiveError(null);
    setArchivePending("archive");
    const optimisticPatch: SessionMutationPatch = {
      archivedAt: new Date().toISOString(),
      ...(session.phaseStatus === "agent_generating" ? { phaseStatus: "rejected" as const } : {}),
    };
    const previousPatch: SessionMutationPatch = {
      archivedAt: session.archivedAt,
      phaseStatus: session.phaseStatus,
      updatedAt: session.updatedAt,
    };

    try {
      await runOptimisticMutation({
        optimistic: () =>
          setSession((current) => applySessionMutationPatch(current, optimisticPatch)),
        mutate: () => archiveSessionFromClient({ sessionId: session.id }),
        commit: (result) =>
          setSession((current) =>
            reconcileSessionMutationPatch(current, {
              archivedAt: result.archivedAt,
              phaseStatus: result.phaseStatus,
              updatedAt: result.updatedAt,
            }),
          ),
        rollback: () =>
          setSession((current) =>
            rollbackSessionMutationPatch(current, optimisticPatch, previousPatch),
          ),
      });
      setArchiveConfirming(false);
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Failed to archive session.");
    } finally {
      setArchivePending(null);
    }
  }

  async function handleUnarchive() {
    if (phaseActionPending !== null || archivePending !== null) return;
    setArchiveError(null);
    setArchivePending("unarchive");
    const optimisticPatch: SessionMutationPatch = { archivedAt: null };
    const previousPatch: SessionMutationPatch = {
      archivedAt: session.archivedAt,
      updatedAt: session.updatedAt,
    };

    try {
      await runOptimisticMutation({
        optimistic: () =>
          setSession((current) => applySessionMutationPatch(current, optimisticPatch)),
        mutate: () => unarchiveSessionFromClient({ sessionId: session.id }),
        commit: (result) =>
          setSession((current) =>
            reconcileSessionMutationPatch(current, {
              archivedAt: result.archivedAt,
              phaseStatus: result.phaseStatus,
              updatedAt: result.updatedAt,
            }),
          ),
        rollback: () =>
          setSession((current) =>
            rollbackSessionMutationPatch(current, optimisticPatch, previousPatch),
          ),
      });
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Failed to unarchive session.");
    } finally {
      setArchivePending(null);
    }
  }

  const headerActions = session.archivedAt ? (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Status value="archived" />
        <button
          type="button"
          className="ui-button gap-1.5"
          disabled={archivePending !== null || phaseActionPending !== null}
          onClick={() => void handleUnarchive()}
        >
          {archivePending ? (
            <>
              <Spinner />
              <span>{archivePending === "archive" ? "Archiving…" : "Unarchiving…"}</span>
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
            disabled={archivePending !== null}
            onClick={() => void handleArchive()}
          >
            {archivePending === "archive" ? (
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
            disabled={archivePending !== null}
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
          disabled={archivePending !== null}
          onClick={() => {
            setArchiveConfirming(true);
            setArchiveError(null);
          }}
        >
          {archivePending === "unarchive" ? (
            <>
              <Spinner />
              <span>Unarchiving…</span>
            </>
          ) : (
            <>
              <ArchiveIcon className="h-3.5 w-3.5" />
              <span>Archive</span>
            </>
          )}
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
      <VisibleInteractionBoundary action="sessions_to_detail" />
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
            onTitleChanged={handleTitleChanged}
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
        <span>
          Created{" "}
          <TimeDisplay absoluteStyle="short" initialNow={renderNow} value={session.createdAt} />
        </span>
        <span aria-hidden="true">·</span>
        <span>
          Updated{" "}
          <TimeDisplay initialNow={renderNow} value={session.updatedAt} variant="relative" />
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

      <div className="ui-sheet mb-6 px-5 py-4">
        <StageRail
          stageRail={stageRail}
          selectedStageSlug={selectedStageSlug}
          onSelect={setSelectedStageSlug}
        />
      </div>

      <div className="flex flex-col gap-6">
        <section className="ui-sheet">
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
              <Status compact value={sessionPhaseStatusValue(session.phaseStatus)} />
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
              initialNow={renderNow}
              isDrafting={isDraftingSelectedStage}
              latestArtifact={latestArtifact}
              loadLatest={shouldLoadLatestArtifact}
              sessionId={session.id}
              stageSlug={selectedStageSlug}
            />
          </div>

          {canStopRun ? (
            <div className="border-t border-border bg-control-muted p-4">
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
            <div className="border-t border-border bg-control-muted p-4">
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

        <section className="ui-sheet p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Prompt</h2>
          <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
            {session.promptMd || "No prompt recorded."}
          </pre>
        </section>

        <section className="ui-sheet p-4">
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
  onTitleChanged,
  sessionId,
  sessionNumber,
  title,
}: {
  onTitleChanged: (title: string, updatedAt?: string, expectedTitle?: string) => void;
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
    setIsEditing(false);
    onTitleChanged(normalizedTitle);

    try {
      const result = await updateSessionTitleFromClient({
        sessionId,
        title: normalizedTitle,
      });
      setDraftTitle(result.title);
      onTitleChanged(result.title, result.updatedAt);
    } catch (errorValue) {
      onTitleChanged(title, undefined, normalizedTitle);
      setIsEditing(true);
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
        aria-label={
          isSaving
            ? `Saving title for session #${sessionNumber}`
            : `Edit title for session #${sessionNumber}`
        }
        title={isSaving ? "Saving title" : "Edit title"}
        disabled={isSaving}
        onClick={startEditing}
      >
        {isSaving ? (
          <Spinner className="h-4 w-4" label="Saving title" />
        ) : (
          <PencilIcon className="h-4 w-4" />
        )}
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
                "group flex items-center gap-2 rounded-[6px] border px-3 py-1.5 text-xs font-medium transition-colors",
                isSelected
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-border bg-sheet text-foreground hover:bg-control-muted",
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
  let value: StatusValue;
  if (entry.status === "completed") {
    value = "complete";
  } else if (entry.status === "upcoming") {
    value = "upcoming";
  } else {
    value = sessionPhaseStatusValue(entry.phaseStatus ?? "agent_generating");
  }

  return <Status compact value={value} />;
}
