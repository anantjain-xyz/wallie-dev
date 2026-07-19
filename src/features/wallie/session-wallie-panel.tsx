"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { Spinner } from "@/components/shared/spinner";
import { TimeDisplay } from "@/components/shared/time-display";
import { Status, agentRunStatusValue } from "@/components/ui/status";
import type { WorkspaceMember } from "@/features/workspace-members/types";
import type {
  AgentRunActionErrorResponse,
  AgentRunActionResponse,
  AgentRunCancelResponse,
  RunHistoryErrorResponse,
  RunHistoryResponse,
} from "@/features/wallie/contracts";
import {
  connectionStateCopy,
  currentOperationLabel,
  formatMessageSourceLabel,
  isRunActivityStalled,
  lastActivityTimestamp,
  messagesDisconnectedCopy,
  messagesEmptyCopy,
  messagesFailedCopy,
  messagesLoadingCopy,
  type WallieRealtimeConnectionState,
} from "@/features/wallie/activity-summary";
import {
  mapAgentRunMessageRow,
  mapAgentRunRow,
  mergeWallieRuns,
  upsertWallieRun,
  upsertWallieRunMessage,
} from "@/features/wallie/data";
import type { WallieSessionData, WallieRun } from "@/features/wallie/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { buildWallieBlockingReasons } from "@/features/wallie/utils";
import { workspaceSettingsPath } from "@/lib/routes";
import { buildStageBranchName } from "@/lib/pipeline/branch-name";
import { cn } from "@/lib/utils";

type FlashMessage = {
  kind: "error" | "info" | "success";
  text: string;
};

export type WalliePanelSession = {
  archivedAt: string | null;
  id: string;
  workspaceId: string;
};

type SessionWalliePanelProps = {
  initialData: WallieSessionData;
  initialNow?: string;
  session: WalliePanelSession;
  supabase?: SupabaseClient<Database>;
  workspaceSlug: string;
};

const interactiveLinkClass =
  "font-semibold text-foreground transition-colors duration-150 hover:text-accent focus-visible:rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

function flashToneClass(kind: FlashMessage["kind"]) {
  switch (kind) {
    case "error":
      return "border-danger/20 bg-danger-soft text-danger";
    case "info":
      return "border-accent/20 bg-accent-soft text-accent";
    default:
      return "border-success/20 bg-success-soft text-success";
  }
}

function actionErrorMessage(payload: AgentRunActionErrorResponse | null) {
  if (!payload) {
    return "Wallie could not queue that run.";
  }

  return payload.error;
}

async function queueRun(endpoint: string, body: Record<string, string>) {
  const response = await fetch(endpoint, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as
    | AgentRunActionErrorResponse
    | AgentRunActionResponse
    | null;

  if (!response.ok) {
    throw new Error(actionErrorMessage(payload as AgentRunActionErrorResponse | null));
  }

  return payload as AgentRunActionResponse;
}

function hydrateRequestedByMember(
  run: WallieRun,
  memberIndex: ReadonlyMap<string, WorkspaceMember>,
): WallieRun {
  if (run.requestedByMember || !run.requestedByMemberId) {
    return run;
  }

  return {
    ...run,
    requestedByMember: memberIndex.get(run.requestedByMemberId) ?? null,
  };
}

function formatStageRunLabel(run: WallieRun) {
  if (run.stageName) {
    return `${run.stageName} run`;
  }

  if (run.stageSlug) {
    const words = run.stageSlug
      .split(/[-_\s]+/g)
      .filter(Boolean)
      .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
    return `${words.join(" ") || "Session"} run`;
  }

  return "Session run";
}

function formatStageName(run: WallieRun) {
  if (run.stageName) return run.stageName;
  if (run.stageSlug) {
    const words = run.stageSlug
      .split(/[-_\s]+/g)
      .filter(Boolean)
      .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
    return words.join(" ") || "Session";
  }
  return "Session";
}

function formatRequestedBy(run: WallieRun) {
  if (run.requestedByMember) {
    const fullName = run.requestedByMember.fullName?.trim();
    const username = run.requestedByMember.username?.trim();

    if (fullName) return fullName;
    if (username) return username;
    if (run.requestedByMember.kind === "system") return "Wallie";
    if (run.requestedByMember.role === "owner") return "workspace owner";
    if (run.requestedByMember.role === "admin") return "workspace admin";
    return "workspace member";
  }

  return run.requestedByMemberId ? "workspace member" : "Wallie";
}

function mapRealtimeStatus(status: string): WallieRealtimeConnectionState | null {
  switch (status) {
    case "SUBSCRIBED":
      return "live";
    case "CHANNEL_ERROR":
    case "TIMED_OUT":
    case "CLOSED":
      return "disconnected";
    default:
      return null;
  }
}

export function SessionWalliePanel({
  initialData,
  initialNow,
  session,
  supabase: injectedSupabase,
  workspaceSlug,
}: SessionWalliePanelProps) {
  const renderNow = initialNow ?? "1970-01-01T00:00:00.000Z";
  const [supabase] = useState<SupabaseClient<Database>>(
    () => injectedSupabase ?? createSupabaseBrowserClient(),
  );
  const [runs, setRuns] = useState(initialData.runs);
  const [nextRunCursor, setNextRunCursor] = useState(initialData.nextRunCursor);
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(
    () => initialData.runs[0]?.id ?? null,
  );
  const [loadedMessageRunIds, setLoadedMessageRunIds] = useState<Set<string>>(
    () => new Set(initialData.loadedMessageRunIds),
  );
  const [messageLoadErrorRunIds, setMessageLoadErrorRunIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isLoadingOlderRuns, setIsLoadingOlderRuns] = useState(false);
  const [olderRunsError, setOlderRunsError] = useState<string | null>(null);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [connectionState, setConnectionState] =
    useState<WallieRealtimeConnectionState>("connecting");
  const [connectionAnnouncement, setConnectionAnnouncement] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.parse(renderNow) || Date.now());
  const sessionIdRef = useRef(session.id);
  const reconcileGenerationRef = useRef(0);
  const hadDisconnectRef = useRef(false);
  sessionIdRef.current = session.id;
  const memberIndex = useMemo(() => {
    const nextIndex = new Map<string, WorkspaceMember>();

    for (const member of initialData.workspaceMembers) {
      nextIndex.set(member.id, member);
    }

    for (const run of initialData.runs) {
      if (run.requestedByMember) {
        nextIndex.set(run.requestedByMember.id, run.requestedByMember);
      }
    }

    return nextIndex;
  }, [initialData.runs, initialData.workspaceMembers]);
  useEffect(() => {
    reconcileGenerationRef.current += 1;
    setRuns(initialData.runs);
    setNextRunCursor(initialData.nextRunCursor);
    setFlashMessage(null);
    setPendingActionId(null);
    setExpandedRunId(initialData.runs[0]?.id ?? null);
    setLoadedMessageRunIds(new Set(initialData.loadedMessageRunIds));
    setMessageLoadErrorRunIds(new Set());
    setIsLoadingOlderRuns(false);
    setOlderRunsError(null);
    setConnectionState("connecting");
    setConnectionAnnouncement(null);
    hadDisconnectRef.current = false;
  }, [initialData.loadedMessageRunIds, initialData.nextRunCursor, initialData.runs, session.id]);

  useEffect(() => {
    const active = runs.some((run) => run.isActive);
    if (!active) return;

    // Keep the first paint aligned with `initialNow` (hydration-safe / testable),
    // then follow the wall clock for live stall detection.
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => window.clearInterval(intervalId);
  }, [runs]);

  const loadRunMessages = useCallback(
    async (runId: string) => {
      setMessageLoadErrorRunIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(runId);
        return nextIds;
      });
      const { data, error } = await supabase
        .from("agent_run_messages")
        .select("agent_run_id, created_at, id, kind, message_md")
        .eq("agent_run_id", runId)
        .order("created_at", { ascending: true });

      if (error) {
        console.error("Wallie could not load run messages", {
          error,
          runId,
        });
        setMessageLoadErrorRunIds((currentIds) => new Set(currentIds).add(runId));
        return;
      }

      setRuns((currentRuns) => {
        let nextRuns = currentRuns;

        for (const row of data ?? []) {
          nextRuns = upsertWallieRunMessage(nextRuns, {
            agentRunId: row.agent_run_id,
            message: mapAgentRunMessageRow(row),
          });
        }

        return nextRuns;
      });
      setLoadedMessageRunIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.add(runId);
        return nextIds;
      });
    },
    [supabase],
  );

  const handleRunRealtimeUpdate = useEffectEvent((row: Tables<"agent_runs">) => {
    setRuns((currentRuns) => {
      const previousRun = currentRuns.find((run) => run.id === row.id);

      return upsertWallieRun(
        currentRuns,
        mapAgentRunRow(row, memberIndex, previousRun?.messages ?? [], {
          attemptCount: previousRun?.attemptCount,
        }),
      );
    });
  });

  const handleRunMessageRealtimeUpdate = useEffectEvent((row: Tables<"agent_run_messages">) => {
    setRuns((currentRuns) =>
      upsertWallieRunMessage(currentRuns, {
        agentRunId: row.agent_run_id,
        message: mapAgentRunMessageRow(row),
      }),
    );
  });

  const reconcileLatestRuns = useEffectEvent(async () => {
    const requestSessionId = session.id;
    const generation = ++reconcileGenerationRef.current;

    try {
      const response = await fetch(`/api/sessions/${requestSessionId}/runs`);
      const payload = (await response.json().catch(() => null)) as
        | RunHistoryResponse
        | RunHistoryErrorResponse
        | null;

      if (!response.ok || !payload || !("runs" in payload)) {
        throw new Error(
          payload && "error" in payload ? payload.error : "Could not reconcile run history.",
        );
      }

      if (
        sessionIdRef.current !== requestSessionId ||
        generation !== reconcileGenerationRef.current
      ) {
        return;
      }

      setRuns((currentRuns) => mergeWallieRuns(currentRuns, payload.runs));
      setNextRunCursor(payload.nextCursor);
    } catch (error) {
      if (sessionIdRef.current !== requestSessionId) {
        return;
      }

      console.error("Wallie could not reconcile run history", {
        error,
        sessionId: requestSessionId,
      });
    }
  });

  useEffect(() => {
    setRealtimeReady(false);
    let started = false;
    let idleId: number | null = null;
    const startRealtime = () => {
      if (started) return;
      started = true;
      setRealtimeReady(true);
    };
    const fallbackId = window.setTimeout(startRealtime, 500);

    if ("requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(startRealtime);
    }

    return () => {
      window.clearTimeout(fallbackId);
      if (idleId !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleId);
      }
    };
  }, [session.id]);

  useEffect(() => {
    if (!realtimeReady) return;

    const runChannel = supabase
      .channel(`wallie-runs:${session.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `session_id=eq.${session.id}`,
          schema: "public",
          table: "agent_runs",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            return;
          }

          handleRunRealtimeUpdate(payload.new as Tables<"agent_runs">);
        },
      )
      .subscribe((status) => {
        const mapped = mapRealtimeStatus(status);
        if (!mapped) return;

        if (mapped === "disconnected") {
          hadDisconnectRef.current = true;
          setConnectionState("disconnected");
          setConnectionAnnouncement(connectionStateCopy("disconnected"));
          return;
        }

        if (mapped === "live") {
          void reconcileLatestRuns();
          if (hadDisconnectRef.current) {
            setConnectionState("recovered");
            setConnectionAnnouncement(connectionStateCopy("recovered"));
            hadDisconnectRef.current = false;
            window.setTimeout(() => {
              setConnectionState((current) => (current === "recovered" ? "live" : current));
            }, 4_000);
          } else {
            setConnectionState("live");
          }
        }
      });

    return () => {
      void supabase.removeChannel(runChannel);
    };
  }, [realtimeReady, session.id, supabase]);

  const summaryRun = useMemo(() => {
    return runs.find((run) => run.isActive) ?? runs[0] ?? null;
  }, [runs]);

  useEffect(() => {
    if (expandedRunId && !loadedMessageRunIds.has(expandedRunId)) {
      void loadRunMessages(expandedRunId);
    }
  }, [expandedRunId, loadRunMessages, loadedMessageRunIds]);

  // Keep the always-visible summary fed even when disclosure stays on an older run
  // (e.g. a new active run arrives while the user still has a prior run expanded).
  useEffect(() => {
    if (summaryRun && !loadedMessageRunIds.has(summaryRun.id)) {
      void loadRunMessages(summaryRun.id);
    }
  }, [loadRunMessages, loadedMessageRunIds, summaryRun]);

  useEffect(() => {
    if (!realtimeReady || !expandedRunId) return;

    const runId = expandedRunId;
    const messageChannel = supabase
      .channel(`wallie-run-messages:${runId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `agent_run_id=eq.${runId}`,
          schema: "public",
          table: "agent_run_messages",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            return;
          }

          handleRunMessageRealtimeUpdate(payload.new as Tables<"agent_run_messages">);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void loadRunMessages(runId);
        }
      });

    return () => {
      void supabase.removeChannel(messageChannel);
    };
  }, [expandedRunId, loadRunMessages, realtimeReady, supabase]);

  useEffect(() => {
    if (!realtimeReady || !summaryRun) return;
    if (summaryRun.id === expandedRunId) return;

    const runId = summaryRun.id;
    const messageChannel = supabase
      .channel(`wallie-summary-messages:${runId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `agent_run_id=eq.${runId}`,
          schema: "public",
          table: "agent_run_messages",
        },
        (payload) => {
          if (payload.eventType === "DELETE") {
            return;
          }

          handleRunMessageRealtimeUpdate(payload.new as Tables<"agent_run_messages">);
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void loadRunMessages(runId);
        }
      });

    return () => {
      void supabase.removeChannel(messageChannel);
    };
  }, [expandedRunId, loadRunMessages, realtimeReady, summaryRun, supabase]);

  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: runs.some((run) => run.isActive),
    missingSecretKeys: initialData.missingSecretKeys,
    mode: initialData.mode,
    repository: initialData.repository,
    requiresVercelSandbox: initialData.requiresVercelSandbox,
    vercelSandboxConnection: initialData.vercelSandboxConnection,
  }).filter((reason) => reason.code !== "active_run");

  // An archived session accepts no new work. The backend rejects retries/runs
  // for archived sessions; mirror that here so the Retry button is disabled
  // rather than failing on click.
  const isArchived = Boolean(session.archivedAt);
  const summaryStalled = summaryRun
    ? isRunActivityStalled({
        createdAt: summaryRun.createdAt,
        isActive: summaryRun.isActive,
        lastActivityAt: summaryRun.lastActivityAt,
        nowMs,
        stallTimeoutMs: initialData.stallTimeoutMs,
        status: summaryRun.status,
      })
    : false;
  const summaryOperation = summaryRun
    ? currentOperationLabel({ run: summaryRun, stalled: summaryStalled })
    : null;
  const summaryLastActivity = summaryRun ? lastActivityTimestamp(summaryRun) : null;

  const handleRetryRun = useCallback(
    async (runId: string) => {
      setPendingActionId(runId);
      setFlashMessage(null);

      try {
        const payload = await queueRun(`/api/agent-runs/${runId}/retry`, {
          workspaceId: session.workspaceId,
        });

        const run = hydrateRequestedByMember(payload.run, memberIndex);

        setRuns((currentRuns) => upsertWallieRun(currentRuns, run));
        setExpandedRunId(run.id);
        setFlashMessage(
          payload.created
            ? {
                kind: "success",
                text: payload.processScheduled
                  ? "Wallie queued the retry for the worker."
                  : "Wallie queued the retry.",
              }
            : {
                kind: "info",
                text: "Wallie already has an active run on this session.",
              },
        );
      } catch (error) {
        setFlashMessage({
          kind: "error",
          text: error instanceof Error ? error.message : "Wallie could not retry that run.",
        });
      } finally {
        setPendingActionId(null);
      }
    },
    [memberIndex, session.workspaceId],
  );

  const handleCancelRun = useCallback(
    async (runId: string) => {
      setPendingActionId(runId);
      setFlashMessage(null);

      try {
        const response = await fetch(`/api/agent-runs/${runId}/cancel`, {
          body: JSON.stringify({ workspaceId: session.workspaceId }),
          headers: {
            "content-type": "application/json",
          },
          method: "POST",
        });
        const payload = (await response.json().catch(() => null)) as
          | AgentRunCancelResponse
          | { error?: string }
          | null;

        if (!response.ok) {
          throw new Error(
            (payload as { error?: string } | null)?.error ?? "Wallie could not cancel that run.",
          );
        }

        const cancelPayload = payload as AgentRunCancelResponse;
        const run = hydrateRequestedByMember(cancelPayload.run, memberIndex);

        setRuns((currentRuns) => upsertWallieRun(currentRuns, run));
        setFlashMessage({
          kind: "info",
          text: cancelPayload.canceled
            ? "Wallie canceled the run and stopped the worker from retrying."
            : "That run had already finished.",
        });
      } catch (error) {
        setFlashMessage({
          kind: "error",
          text: error instanceof Error ? error.message : "Wallie could not cancel that run.",
        });
      } finally {
        setPendingActionId(null);
      }
    },
    [memberIndex, session.workspaceId],
  );

  const handleToggleRun = useCallback((runId: string) => {
    setExpandedRunId((currentRunId) => (currentRunId === runId ? null : runId));
  }, []);

  const handleLoadOlderRuns = useCallback(async () => {
    if (!nextRunCursor || isLoadingOlderRuns) return;

    const requestSessionId = session.id;
    const requestCursor = nextRunCursor;

    setIsLoadingOlderRuns(true);
    setOlderRunsError(null);

    try {
      const searchParams = new URLSearchParams({
        createdAt: requestCursor.createdAt,
        id: requestCursor.id,
      });
      const response = await fetch(`/api/sessions/${requestSessionId}/runs?${searchParams}`);
      const payload = (await response.json().catch(() => null)) as
        | RunHistoryResponse
        | RunHistoryErrorResponse
        | null;

      if (!response.ok || !payload || !("runs" in payload)) {
        throw new Error(
          payload && "error" in payload ? payload.error : "Could not load older runs.",
        );
      }

      if (sessionIdRef.current !== requestSessionId) {
        return;
      }

      setRuns((currentRuns) => mergeWallieRuns(currentRuns, payload.runs));
      setNextRunCursor(payload.nextCursor);
    } catch (error) {
      if (sessionIdRef.current !== requestSessionId) {
        return;
      }

      setOlderRunsError(error instanceof Error ? error.message : "Could not load older runs.");
    } finally {
      if (sessionIdRef.current === requestSessionId) {
        setIsLoadingOlderRuns(false);
      }
    }
  }, [isLoadingOlderRuns, nextRunCursor, session.id]);

  return (
    <div className="min-w-0 space-y-5 overflow-x-clip">
      {flashMessage ? (
        <div
          aria-live="polite"
          className={cn(
            "rounded-[6px] border px-4 py-3 text-sm leading-6",
            flashToneClass(flashMessage.kind),
          )}
          role="status"
        >
          {flashMessage.text}
        </div>
      ) : null}

      {connectionAnnouncement ? (
        <div aria-live="polite" className="sr-only" role="status">
          {connectionAnnouncement}
        </div>
      ) : null}

      {initialData.requiredSecretKeys.length > 0 ? (
        <div className="border-y border-border p-4">
          <p className="ui-label">Required secrets</p>
          <p className="mt-2 text-sm text-foreground">
            {initialData.requiredSecretKeys.join(", ")}
          </p>
          <p className="mt-2 text-sm text-muted">
            {initialData.missingSecretKeys.length === 0
              ? "All required secrets are configured."
              : `Missing: ${initialData.missingSecretKeys.join(", ")}`}
          </p>
          {initialData.missingSecretKeys.length > 0 ? (
            <div className="mt-3">
              <Link className={interactiveLinkClass} href={workspaceSettingsPath(workspaceSlug)}>
                Open Workspace Settings
              </Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {isArchived ? (
        <div
          aria-live="polite"
          className="rounded-[6px] border border-border bg-control-muted p-5 text-sm leading-7 text-muted"
          role="status"
        >
          This session is archived. Unarchive it to run Wallie again.
        </div>
      ) : null}

      {blockingReasons.length > 0 ? (
        <div className="rounded-[6px] border border-warning/20 bg-warning-soft p-5 text-sm leading-7 text-warning">
          <p className="font-semibold">Wallie is not ready to run.</p>
          <ul className="mt-3 space-y-2">
            {blockingReasons.map((reason) => (
              <li key={reason.code}>{reason.message}</li>
            ))}
          </ul>
          <div className="mt-4">
            <Link className={interactiveLinkClass} href={workspaceSettingsPath(workspaceSlug)}>
              Open Workspace Settings
            </Link>
          </div>
        </div>
      ) : null}

      <ActiveRunSummary
        actionPending={summaryRun ? pendingActionId === summaryRun.id : false}
        cancelLocked={pendingActionId !== null}
        connectionState={connectionState}
        lastActivityAt={summaryLastActivity}
        onCancel={handleCancelRun}
        onRetry={handleRetryRun}
        operation={summaryOperation}
        renderNow={renderNow}
        retryLocked={pendingActionId !== null || blockingReasons.length > 0 || isArchived}
        run={summaryRun}
        stalled={summaryStalled}
      />

      <div className="min-w-0 divide-y divide-border border-y border-border">
        {runs.length === 0 ? (
          <div className="py-5 text-sm leading-7 text-muted">No runs recorded yet.</div>
        ) : (
          runs.map((run) => (
            <WallieRunCard
              key={run.id}
              actionPending={pendingActionId === run.id}
              branchName={
                run.stageSlug
                  ? buildStageBranchName(session.id, run.stageSlug)
                  : (initialData.repository?.defaultBranch ?? null)
              }
              cancelLocked={pendingActionId !== null}
              connectionState={connectionState}
              isExpanded={expandedRunId === run.id}
              messagesLoaded={loadedMessageRunIds.has(run.id)}
              messagesLoadFailed={messageLoadErrorRunIds.has(run.id)}
              nowMs={nowMs}
              onCancel={handleCancelRun}
              onRetry={handleRetryRun}
              onToggle={handleToggleRun}
              renderNow={renderNow}
              retryLocked={pendingActionId !== null || blockingReasons.length > 0 || isArchived}
              run={run}
              stallTimeoutMs={initialData.stallTimeoutMs}
            />
          ))
        )}
      </div>

      {olderRunsError ? (
        <p aria-live="polite" className="text-sm text-danger" role="status">
          {olderRunsError}
        </p>
      ) : null}

      {nextRunCursor ? (
        <button
          className="ui-button"
          disabled={isLoadingOlderRuns}
          onClick={() => void handleLoadOlderRuns()}
          type="button"
        >
          {isLoadingOlderRuns ? "Loading older runs…" : "Load older runs"}
        </button>
      ) : null}
    </div>
  );
}

type ActiveRunSummaryProps = {
  actionPending: boolean;
  cancelLocked: boolean;
  connectionState: WallieRealtimeConnectionState;
  lastActivityAt: string | null;
  onCancel: (runId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
  operation: string | null;
  renderNow: string;
  retryLocked: boolean;
  run: WallieRun | null;
  stalled: boolean;
};

function ActiveRunSummary({
  actionPending,
  cancelLocked,
  connectionState,
  lastActivityAt,
  onCancel,
  onRetry,
  operation,
  renderNow,
  retryLocked,
  run,
  stalled,
}: ActiveRunSummaryProps) {
  if (!run) {
    return (
      <section
        aria-label="Current Wallie activity"
        className="min-w-0 border-y border-border py-4 text-sm leading-7 text-muted"
      >
        No active Wallie run.
      </section>
    );
  }

  const showRecovery = stalled && run.isActive && run.canCancel;
  const showRetryRecovery = stalled && !run.isActive && run.canRetry;

  return (
    <section
      aria-label="Current Wallie activity"
      className="min-w-0 border-y border-border py-4"
      data-wallie-summary=""
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-2">
          <p className="ui-label">Current activity</p>
          <p className="text-sm font-semibold text-foreground">{formatStageName(run)}</p>
          <p className="min-w-0 break-words text-sm text-foreground [overflow-wrap:anywhere]">
            {operation}
          </p>
        </div>
        <Status value={agentRunStatusValue(run.status)} />
      </div>

      <dl className="mt-4 grid min-w-0 gap-2 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="type-annotation text-muted">Elapsed</dt>
          <dd className="text-foreground">
            {run.startedAt ? (
              <TimeDisplay
                active={run.isActive}
                endValue={run.finishedAt}
                initialNow={renderNow}
                value={run.startedAt}
                variant="elapsed"
              />
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="type-annotation text-muted">Last event</dt>
          <dd className="text-foreground">
            {lastActivityAt ? (
              <TimeDisplay
                absoluteStyle="short"
                initialNow={renderNow}
                value={lastActivityAt}
                variant="relative"
              />
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="type-annotation text-muted">Connection</dt>
          <dd className="text-foreground">{connectionStateCopy(connectionState)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="type-annotation text-muted">Attempt</dt>
          <dd className="text-foreground">{run.attemptCount}</dd>
        </div>
      </dl>

      {stalled ? (
        <div
          aria-live="polite"
          className="mt-4 border-t border-border pt-3 text-sm text-warning"
          role="status"
        >
          No recent activity
          {showRecovery || showRetryRecovery ? ". Use the recovery action to continue." : "."}
        </div>
      ) : null}

      {showRecovery ? (
        <div className="mt-3">
          <button
            className="ui-button-danger"
            disabled={cancelLocked}
            onClick={() => void onCancel(run.id)}
            type="button"
          >
            {actionPending ? "Canceling…" : "Cancel run"}
          </button>
        </div>
      ) : null}

      {showRetryRecovery ? (
        <div className="mt-3">
          <button
            className="ui-button"
            disabled={retryLocked}
            onClick={() => void onRetry(run.id)}
            type="button"
          >
            {actionPending ? "Retrying…" : "Retry run"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

type WallieRunCardProps = {
  actionPending: boolean;
  branchName: string | null;
  cancelLocked: boolean;
  connectionState: WallieRealtimeConnectionState;
  isExpanded: boolean;
  messagesLoaded: boolean;
  messagesLoadFailed: boolean;
  nowMs: number;
  onCancel: (runId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
  onToggle: (runId: string) => void;
  renderNow: string;
  retryLocked: boolean;
  run: WallieRun;
  stallTimeoutMs: number;
};

const WallieRunCard = memo(function WallieRunCard({
  actionPending,
  branchName,
  cancelLocked,
  connectionState,
  isExpanded,
  messagesLoaded,
  messagesLoadFailed,
  nowMs,
  onCancel,
  onRetry,
  onToggle,
  renderNow,
  retryLocked,
  run,
  stallTimeoutMs,
}: WallieRunCardProps) {
  const runDetailsId = `wallie-run-details-${run.id}`;
  const stalled = isRunActivityStalled({
    createdAt: run.createdAt,
    isActive: run.isActive,
    lastActivityAt: run.lastActivityAt,
    nowMs,
    stallTimeoutMs,
    status: run.status,
  });

  return (
    <article
      aria-busy={run.isActive}
      className={cn("min-w-0 py-5", !isExpanded && !run.isActive && "run-history-group")}
      data-run-id={run.id}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <button
          aria-controls={runDetailsId}
          aria-expanded={isExpanded}
          className="min-w-0 flex-1 text-left"
          onClick={() => onToggle(run.id)}
          type="button"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <Status value={agentRunStatusValue(run.status)} />
            <span className="type-annotation text-muted">Attempt {run.attemptCount}</span>
            <span className="min-w-0 break-all font-mono type-annotation text-foreground">
              {run.modelProvider}/{run.modelName}
            </span>
          </div>

          <p className="mt-3 text-sm font-semibold text-foreground">{formatStageRunLabel(run)}</p>
          <p className="mt-1 text-sm text-muted">
            {run.startedAt ? (
              <>
                Started{" "}
                <TimeDisplay absoluteStyle="short" initialNow={renderNow} value={run.startedAt} />
                {" · Duration "}
                <TimeDisplay
                  active={run.isActive}
                  endValue={run.finishedAt}
                  initialNow={renderNow}
                  value={run.startedAt}
                  variant="elapsed"
                />
              </>
            ) : (
              <>
                Created{" "}
                <TimeDisplay absoluteStyle="short" initialNow={renderNow} value={run.createdAt} />
              </>
            )}
            {run.finishedAt ? (
              <>
                {" · Ended "}
                <TimeDisplay absoluteStyle="short" initialNow={renderNow} value={run.finishedAt} />
              </>
            ) : null}
          </p>
          <p className="mt-1 text-sm text-muted">Requested by {formatRequestedBy(run)}</p>
        </button>

        {run.canCancel ? (
          <button
            className="ui-button-danger"
            disabled={cancelLocked}
            onClick={() => void onCancel(run.id)}
            type="button"
          >
            {actionPending ? "Canceling…" : "Cancel"}
          </button>
        ) : null}

        {run.canRetry ? (
          <button
            className="ui-button"
            disabled={retryLocked}
            onClick={() => void onRetry(run.id)}
            type="button"
          >
            {actionPending ? "Retrying…" : "Retry Run"}
          </button>
        ) : null}
      </div>

      {isExpanded ? (
        <div id={runDetailsId} className="mt-4 min-w-0 space-y-4 border-t border-border/70 pt-4">
          <details className="min-w-0 text-sm">
            <summary className="cursor-pointer type-annotation font-semibold text-muted">
              Run details
            </summary>
            <dl className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="type-annotation text-muted">Run ID</dt>
                <dd className="break-all font-mono text-foreground">{run.id}</dd>
              </div>
              {branchName ? (
                <div className="min-w-0">
                  <dt className="type-annotation text-muted">Branch</dt>
                  <dd className="break-all font-mono text-foreground">{branchName}</dd>
                </div>
              ) : null}
              {run.sandboxId ? (
                <div className="min-w-0">
                  <dt className="type-annotation text-muted">Sandbox</dt>
                  <dd className="break-all font-mono text-foreground">
                    {run.sandboxProvider ? `${run.sandboxProvider}/` : ""}
                    {run.sandboxId}
                  </dd>
                </div>
              ) : null}
            </dl>
          </details>

          <RunMessageTimeline
            connectionState={connectionState}
            messages={run.messages}
            messagesLoadFailed={messagesLoadFailed}
            messagesLoaded={messagesLoaded}
            renderNow={renderNow}
            run={run}
            stalled={stalled}
          />
        </div>
      ) : null}
    </article>
  );
});

function RunMessageTimeline({
  connectionState,
  messages,
  messagesLoadFailed,
  messagesLoaded,
  renderNow,
  run,
  stalled,
}: {
  connectionState: WallieRealtimeConnectionState;
  messages: WallieRun["messages"];
  messagesLoadFailed: boolean;
  messagesLoaded: boolean;
  renderNow: string;
  run: WallieRun;
  stalled: boolean;
}) {
  const disconnected = connectionState === "disconnected";

  return (
    <div className="min-w-0">
      <p className="ui-label">Messages</p>

      {messages.length > 0 ? (
        <ol className="mt-3 min-w-0 divide-y divide-border border-y border-border">
          {messages.map((message) => (
            <li key={message.id} className="min-w-0 py-3">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 type-annotation text-muted">
                <span>{formatMessageSourceLabel(message.kind)}</span>
                <TimeDisplay
                  absoluteStyle="short"
                  initialNow={renderNow}
                  value={message.createdAt}
                />
              </div>
              <p
                className={cn(
                  "mt-2 min-w-0 whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]",
                  message.kind === "error" ? "text-danger" : "text-foreground",
                )}
              >
                {message.messageMd}
              </p>
            </li>
          ))}
        </ol>
      ) : null}

      {messages.length === 0 && !run.isActive && messagesLoadFailed ? (
        <div aria-live="polite" className="mt-3 text-sm text-danger" role="status">
          {messagesFailedCopy()}
        </div>
      ) : null}
      {messages.length === 0 && !run.isActive && !messagesLoaded && !messagesLoadFailed ? (
        <div aria-live="polite" className="mt-3 text-sm text-muted" role="status">
          {messagesLoadingCopy()}
        </div>
      ) : null}
      {messages.length === 0 && !run.isActive && messagesLoaded ? (
        <div aria-live="polite" className="mt-3 text-sm text-muted" role="status">
          {messagesEmptyCopy()}
        </div>
      ) : null}
      {run.isActive ? (
        <div
          aria-busy
          aria-live="polite"
          className="mt-3 flex items-center gap-2 text-sm text-muted"
          role="status"
        >
          {stalled ? null : <Spinner />}
          <span>
            {stalled
              ? "No recent activity"
              : disconnected
                ? messagesDisconnectedCopy()
                : "Wallie is working…"}
          </span>
        </div>
      ) : null}
      {disconnected && messages.length > 0 ? (
        <p className="mt-3 text-sm text-muted">{messagesDisconnectedCopy()}</p>
      ) : null}
    </div>
  );
}
