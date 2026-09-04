"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";

import { PAGE_HEADER_TITLE_CLASS, PageContainer, PageHeader } from "@/components/ui/page-shell";
import { ArchiveIcon } from "@/components/shared/icons/archive-icon";
import { Spinner } from "@/components/shared/spinner";
import { VisibleInteractionBoundary } from "@/components/telemetry/visible-interaction-boundary";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Status } from "@/components/ui/status";
import { useOptionalToast } from "@/components/ui/toast";
import {
  archiveSessionFromClient,
  isSessionPhaseMutationResult,
  loadSessionStateFromClient,
  unarchiveSessionFromClient,
  updateSessionTitleFromClient,
} from "@/features/sessions/client";
import { ARTIFACT_STAGE_PARAM, ArtifactPanel } from "@/features/sessions/detail/artifact-panel";
import type {
  SessionReviewData,
  SessionReviewRepository,
  SessionReviewSession,
} from "@/features/sessions/detail/data";
import { resolveReviewMode } from "@/features/sessions/detail/review-mode";
import { SessionActivityArchivedAtProvider } from "@/features/sessions/detail/session-activity-client";
import { SessionInspector } from "@/features/sessions/detail/session-inspector";
import { SessionReviewBar } from "@/features/sessions/detail/session-review-bar";
import { buildStageTimeline, StageTimeline } from "@/features/sessions/detail/stage-timeline";
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
import type { SessionArtifactSummary } from "@/features/sessions/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { workspaceSessionsPath } from "@/lib/routes";
import { finishInteraction, startInteraction } from "@/lib/telemetry/interaction-rum";
import { cn } from "@/lib/utils";

type SessionDetailPageClientProps = {
  activity: ReactNode;
  canReview?: boolean;
  failedStageSlug?: string | null;
  hasFailedRun?: boolean;
  initialData: SessionReviewData;
  initialFormattedArtifact: ReactNode | null;
  initialFormattedArtifactKey: string | null;
  initialNow?: string;
  repository?: SessionReviewRepository | null;
};

type ArchiveUndoVersion = {
  archivedAt: string;
};

function isCurrentArchiveVersion(
  session: Pick<SessionReviewSession, "archivedAt">,
  version: ArchiveUndoVersion,
) {
  return session.archivedAt === version.archivedAt;
}

function stageIndex(pipeline: SessionReviewSession["pipeline"], stageSlug: string): number {
  return pipeline.stages.findIndex((stage) => stage.slug === stageSlug);
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

export { centerStageTimelineSelection as centerStageRailSelection } from "@/features/sessions/detail/stage-timeline";

export function SessionDetailPageClient({
  activity,
  canReview = true,
  failedStageSlug: initialFailedStageSlug = null,
  hasFailedRun: initialHasFailedRun = false,
  initialData,
  initialFormattedArtifact,
  initialFormattedArtifactKey,
  initialNow,
  repository = null,
}: SessionDetailPageClientProps) {
  const renderNow = initialNow ?? "1970-01-01T00:00:00.000Z";
  const router = useRouter();
  const searchParams = useSearchParams();
  const { pushToast } = useOptionalToast();
  const [supabase] = useState<SupabaseClient<Database>>(() => createSupabaseBrowserClient());
  const [session, setSession] = useState(initialData.session);
  const latestSessionRef = useRef(session);
  latestSessionRef.current = session;
  const creatorDisplayName = initialData.creatorDisplayName;
  const [selectedStageSlug, setSelectedStageSlug] = useState<string>(() => {
    const fromUrl = searchParams.get(ARTIFACT_STAGE_PARAM);
    if (fromUrl && initialData.session.pipeline.stages.some((stage) => stage.slug === fromUrl)) {
      return fromUrl;
    }
    return initialData.session.currentStageSlug;
  });
  const [canApprove, setCanApprove] = useState(canReview);
  const [hasFailedRun, setHasFailedRun] = useState(initialHasFailedRun);
  const [failedStageSlug, setFailedStageSlug] = useState<string | null>(initialFailedStageSlug);
  const [phaseActionPending, setPhaseActionPending] = useState<"approve" | "reject" | null>(null);
  const [stopPending, setStopPending] = useState(false);
  const [archivePending, setArchivePending] = useState<"archive" | "unarchive" | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [viewingHistoricalArtifact, setViewingHistoricalArtifact] = useState(false);
  const archiveUndoVersionRef = useRef<ArchiveUndoVersion | null>(null);
  const pullRequestUpdatedAtRef = useRef(new Map<string, string>());
  const capabilitiesEffectSkipRef = useRef(true);

  const stageTimeline = useMemo(
    () => buildStageTimeline(session, { failedStageSlug }),
    [failedStageSlug, session],
  );

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
    (session.phaseStatus === "in_progress" || stopPending) &&
    !session.archivedAt;

  const reviewMode = resolveReviewMode({
    archivedAt: session.archivedAt,
    canApprove,
    hasFailedRun,
    phaseStatus: session.phaseStatus,
    selectedStageIsCurrent,
  });
  // Optimistic approve/reject flips phaseStatus before the network settles.
  // Keep the reviewable pending surface so Stop/dialog cannot race the action.
  // Historical version selections disable approve/reject — those actions always
  // target session.currentArtifactVersion, not the on-screen older body.
  const pendingKeepsReviewable =
    (phaseActionPending === "approve" || phaseActionPending === "reject") &&
    (reviewMode.kind === "running" || reviewMode.kind === "canceled");
  const stickyReviewMode =
    viewingHistoricalArtifact && (reviewMode.kind === "reviewable" || pendingKeepsReviewable)
      ? ({
          kind: "historical_version",
          reason:
            "You’re viewing an older version. Return to Latest to approve or request changes.",
        } as const)
      : pendingKeepsReviewable
        ? ({ canApprove, kind: "reviewable" } as const)
        : reviewMode;

  useEffect(() => {
    setSession(initialData.session);
    setCanApprove(canReview);
    setHasFailedRun(initialHasFailedRun);
    setFailedStageSlug(initialFailedStageSlug);
    setSelectedStageSlug((currentSlug) => {
      const stageStillExists = initialData.session.pipeline.stages.some(
        (stage) => stage.slug === currentSlug,
      );

      return stageStillExists ? currentSlug : initialData.session.currentStageSlug;
    });
  }, [canReview, initialData.session, initialFailedStageSlug, initialHasFailedRun]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    // Skip the mount pass — RSC already supplied canApprove / hasFailedRun.
    // Recompute when the current stage or phase status changes (Realtime / local).
    if (capabilitiesEffectSkipRef.current) {
      capabilitiesEffectSkipRef.current = false;
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    // Wait out in-flight phase actions so we don't race the mutation request.
    if (phaseActionPending !== null) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }

    const phaseStatusAtFetch = session.phaseStatus;

    void fetch(`/api/sessions/${session.id}/review-capabilities`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as {
          canApprove?: boolean;
          failedStageSlug?: string | null;
          hasFailedRun?: boolean;
        } | null;
        if (!response.ok || !body || cancelled) return;
        if (typeof body.canApprove === "boolean") setCanApprove(body.canApprove);
        // Generating / awaiting_review clear failure UI immediately (sibling effect).
        // Ignore a stale error run so refetch-on-phaseStatus cannot resurrect it.
        if (phaseStatusAtFetch === "in_progress" || phaseStatusAtFetch === "awaiting_review") {
          setHasFailedRun(false);
          setFailedStageSlug(null);
          return;
        }
        if (typeof body.hasFailedRun === "boolean") setHasFailedRun(body.hasFailedRun);
        if ("failedStageSlug" in body) setFailedStageSlug(body.failedStageSlug ?? null);
      })
      .catch(() => {
        // Keep the last known capabilities; review actions still authorize server-side.
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [phaseActionPending, session.currentStageId, session.id, session.phaseStatus]);

  useEffect(() => {
    if (session.phaseStatus === "in_progress" || session.phaseStatus === "awaiting_review") {
      setHasFailedRun(false);
      setFailedStageSlug(null);
    }
  }, [session.phaseStatus]);

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
          pushToast({
            description:
              error instanceof Error ? error.message : "Could not reconcile the updated stage.",
            priority: "assertive",
            title: "Could not sync stage.",
            tone: "danger",
          });
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

  async function handlePhaseAction(
    action: "approve" | "reject",
    feedbackText?: string,
  ): Promise<boolean> {
    if (phaseActionPending !== null) return false;
    if (viewingHistoricalArtifact) return false;

    if (action === "reject") {
      if (!feedbackText?.trim()) {
        return false;
      }
    }

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
              phaseStatus: "in_progress",
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
              feedbackText: action === "reject" ? feedbackText?.trim() : undefined,
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

      finishInteraction(action, "success");
      pushToast({
        priority: "polite",
        title: action === "approve" ? "Review approved." : "Changes queued.",
        tone: "success",
      });
      return true;
    } catch (error) {
      finishInteraction(action, "error");
      pushToast({
        description: error instanceof Error ? error.message : "Action failed.",
        priority: "assertive",
        title: action === "approve" ? "Approval failed." : "Could not queue changes.",
        tone: "danger",
      });
      return false;
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
    if (archivePending !== null || phaseActionPending !== null || stopPending) return;
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
      pushToast({
        description: error instanceof Error ? error.message : "Could not stop the run.",
        priority: "assertive",
        title: "Stop failed.",
        tone: "danger",
      });
    } finally {
      setStopPending(false);
    }
  }

  async function handleArchive() {
    if (archivePending !== null || phaseActionPending !== null || stopPending) return;
    archiveUndoVersionRef.current = null;
    setArchiveError(null);
    setArchivePending("archive");
    const optimisticPatch: SessionMutationPatch = {
      archivedAt: new Date().toISOString(),
      ...(session.phaseStatus === "in_progress" ? { phaseStatus: "rejected" as const } : {}),
    };
    const previousPatch: SessionMutationPatch = {
      archivedAt: session.archivedAt,
      phaseStatus: session.phaseStatus,
      updatedAt: session.updatedAt,
    };

    try {
      const result = await runOptimisticMutation({
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
      if (!result.archivedAt) {
        pushToast({
          priority: "polite",
          title: `Session #${session.number} remains active.`,
        });
        return;
      }
      const undoVersion = {
        archivedAt: result.archivedAt,
      } satisfies ArchiveUndoVersion;
      archiveUndoVersionRef.current = undoVersion;
      pushToast({
        action: {
          altText: `Undo archive for session #${session.number}`,
          label: "Undo",
          onClick: () => {
            if (
              archiveUndoVersionRef.current !== undoVersion ||
              !isCurrentArchiveVersion(latestSessionRef.current, undoVersion)
            ) {
              return;
            }
            void handleUnarchive(undoVersion.archivedAt, true);
          },
        },
        duration: 7000,
        priority: "polite",
        title: `Session #${session.number} archived.`,
        tone: "success",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to archive session.";
      setArchiveError(message);
      pushToast({
        description: message,
        priority: "assertive",
        title: "Archive failed.",
        tone: "danger",
      });
    } finally {
      setArchivePending(null);
    }
  }

  async function handleUnarchive(expectedArchivedAt?: string, refreshActiveRoute = false) {
    if (phaseActionPending !== null || archivePending !== null) return;
    archiveUndoVersionRef.current = null;
    const currentSession = latestSessionRef.current;
    setArchiveError(null);
    setArchivePending("unarchive");
    const optimisticPatch: SessionMutationPatch = { archivedAt: null };
    const previousPatch: SessionMutationPatch = {
      archivedAt: currentSession.archivedAt,
      updatedAt: currentSession.updatedAt,
    };

    try {
      const result = await runOptimisticMutation({
        optimistic: () =>
          setSession((current) => applySessionMutationPatch(current, optimisticPatch)),
        mutate: () =>
          unarchiveSessionFromClient({ expectedArchivedAt, sessionId: currentSession.id }),
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
      if (result.archivedAt !== null) return;
      pushToast({
        priority: "polite",
        title: `Session #${currentSession.number} unarchived.`,
        tone: "success",
      });
      if (refreshActiveRoute) router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to unarchive session.";
      setArchiveError(message);
      pushToast({
        description: message,
        priority: "assertive",
        title: "Unarchive failed.",
        tone: "danger",
      });
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
          <ActionButtonLabel
            idle="Unarchive"
            pending={archivePending !== null}
            pendingLabel={archivePending === "archive" ? "Archiving…" : "Unarchiving…"}
          />
        </button>
      </div>
      {archiveError ? <span className="text-xs text-danger">{archiveError}</span> : null}
    </div>
  ) : (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {session.phaseStatus === "in_progress" && phaseActionPending === null ? (
          <button
            type="button"
            className="ui-button-danger"
            disabled={stopPending || archivePending !== null || phaseActionPending !== null}
            onClick={() => void handleStopRun()}
          >
            <ActionButtonLabel idle="Stop run" pending={stopPending} pendingLabel="Stopping…" />
          </button>
        ) : null}
        <button
          type="button"
          className="ui-button gap-1.5"
          disabled={archivePending !== null || phaseActionPending !== null || stopPending}
          onClick={() => void handleArchive()}
        >
          <ArchiveIcon className="h-3.5 w-3.5" />
          <ActionButtonLabel
            idle="Archive"
            pending={archivePending === "archive"}
            pendingLabel="Archiving…"
          />
        </button>
      </div>
      {archiveError ? <span className="text-xs text-danger">{archiveError}</span> : null}
    </div>
  );

  const nextStage =
    currentStagePosition >= 0 ? session.pipeline.stages[currentStagePosition + 1] : null;
  const isFinalStage =
    currentStagePosition === session.pipeline.stages.length - 1 && currentStagePosition >= 0;
  const approveLabel = nextStage
    ? `Approve & start ${nextStage.name}`
    : isFinalStage
      ? "Approve & complete"
      : "Approve";

  return (
    <PageContainer className="pb-4">
      <VisibleInteractionBoundary action="sessions_to_detail" />
      <PageHeader
        actionsAlwaysRight
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

      <div className="mb-4">
        <StageTimeline
          onSelect={setSelectedStageSlug}
          selectedStageSlug={selectedStageSlug}
          timeline={stageTimeline}
        />
      </div>

      {/* Review workbench: 70/30 on lg+, stacked below 1024px with context after artifact. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(18rem,3fr)] lg:gap-0 lg:gap-x-0">
        <section className="ui-sheet flex min-h-0 flex-col lg:rounded-r-none lg:border-r-0">
          <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold text-foreground">
                {selectedStage?.name ?? selectedStageSlug} artifact
              </h2>
              <p className="mt-0.5 type-annotation text-muted">
                {latestArtifact && stickyReviewMode.kind === "reviewable"
                  ? "Review this output before approving."
                  : (selectedStage?.description ?? "")}
              </p>
            </div>
          </div>

          <div
            aria-busy={isDraftingSelectedStage}
            aria-live="polite"
            className="min-h-0 flex-1 p-4"
          >
            <ArtifactPanel
              emptyText={
                selectedStagePosition > currentStagePosition
                  ? "This stage has not started yet."
                  : "No artifact recorded for this stage."
              }
              initialFormattedArtifact={initialFormattedArtifact}
              initialFormattedArtifactKey={initialFormattedArtifactKey}
              initialNow={renderNow}
              isAwaitingReview={selectedStageIsCurrent && session.phaseStatus === "awaiting_review"}
              isDrafting={isDraftingSelectedStage}
              latestArtifact={latestArtifact}
              loadLatest={shouldLoadLatestArtifact}
              onViewingHistoricalChange={setViewingHistoricalArtifact}
              persistStageInUrl={!selectedStageIsCurrent}
              rejectionCount={selectedStageIsCurrent ? (session.rejectionCount ?? 0) : undefined}
              sessionId={session.id}
              stageSlug={selectedStageSlug}
            />
          </div>
        </section>

        <aside className="ui-sheet p-4 lg:rounded-l-none">
          <SessionInspector
            creatorDisplayName={creatorDisplayName}
            initialNow={renderNow}
            repository={repository}
            session={session}
          />
        </aside>
      </div>

      <section aria-labelledby="session-runs-heading" className="ui-sheet mt-6">
        <div className="border-b border-border px-4 py-3">
          <h2 id="session-runs-heading" className="text-[13px] font-semibold text-foreground">
            Runs
          </h2>
          <p className="mt-0.5 type-annotation text-muted">
            Review agent run history, status, and messages for this session.
          </p>
        </div>
        <div className="p-4">
          <SessionActivityArchivedAtProvider archivedAt={session.archivedAt}>
            {activity}
          </SessionActivityArchivedAtProvider>
        </div>
      </section>

      <SessionReviewBar
        approveLabel={approveLabel}
        approveDescription={isFinalStage ? "Completing this session archives it." : undefined}
        mode={stickyReviewMode}
        onApprove={() => {
          void handlePhaseAction("approve");
        }}
        onReject={(feedback) => handlePhaseAction("reject", feedback)}
        phaseActionPending={phaseActionPending}
      />
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
  const { pushToast } = useOptionalToast();
  const [draftTitle, setDraftTitle] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextBlurSaveRef = useRef(false);

  useEffect(() => {
    if (!isEditing) return;
    editInputRef.current?.focus();
  }, [isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    editInputRef.current?.select();
  }, [isEditing]);

  function startEditing() {
    skipNextBlurSaveRef.current = false;
    setDraftTitle(title);
    setError(null);
    setIsEditing(true);
  }

  function cancelEditing() {
    skipNextBlurSaveRef.current = true;
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
      pushToast({ priority: "polite", title: "Session title updated.", tone: "success" });
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
            aria-describedby={error ? `session-${sessionNumber}-title-error` : undefined}
            className="ui-input h-11 min-w-0 w-full px-3 py-1.5 text-[20px] font-semibold sm:text-[22px]"
            disabled={isSaving}
            value={draftTitle}
            onBlur={() => {
              if (skipNextBlurSaveRef.current) {
                skipNextBlurSaveRef.current = false;
                return;
              }
              void saveTitle();
            }}
            onChange={(event) => {
              setDraftTitle(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelEditing();
              }
            }}
          />
        </div>
        {error ? (
          <p
            className="text-xs leading-4 text-danger"
            id={`session-${sessionNumber}-title-error`}
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <h1 className={cn(PAGE_HEADER_TITLE_CLASS, "min-w-0")}>
      <button
        type="button"
        aria-busy={isSaving}
        className="max-w-full cursor-text rounded-[4px] text-left text-inherit outline-none transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-wait disabled:opacity-70"
        disabled={isSaving}
        onClick={startEditing}
      >
        {title}
        {isSaving ? <Spinner className="ml-2 align-middle text-muted" /> : null}
      </button>
    </h1>
  );
}
