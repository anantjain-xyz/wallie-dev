"use client";

import Link from "next/link";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { usePublishExecution } from "@/features/sessions/detail/execution-summary";
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
  type WallieRealtimeConnectionState,
} from "@/features/wallie/activity-summary";
import { WallieRunCard } from "@/features/wallie/run-activity";
import {
  mapAgentRunMessageRow,
  mapAgentRunRow,
  mergeWallieRuns,
  nextAttemptOrdinal,
  upsertWallieRun,
  upsertWallieRunMessage,
} from "@/features/wallie/data";
import type { WallieRun, WallieSessionData } from "@/features/wallie/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { buildWallieBlockingReasons } from "@/features/wallie/utils";
import { workspaceSettingsPath } from "@/lib/routes";
import { buildStageBranchName } from "@/lib/pipeline/branch-name";
import { cn } from "@/lib/utils";

/** Cap auto-loaded message history so opening a busy run cannot mount unbounded logs. */
export const WALLIE_RUN_MESSAGE_LIMIT = 100;

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
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
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
  const messageGenerationRef = useRef(0);
  const hadDisconnectRef = useRef(false);
  // Track each required realtime channel independently; recovery only when all are live.
  const channelHealthRef = useRef({
    expandedMessages: null as boolean | null,
    runs: false,
    summaryMessages: null as boolean | null,
  });
  sessionIdRef.current = session.id;
  usePublishExecution({
    sessionId: session.id,
    run: runs[0],
    connection: connectionState,
    nowMs,
    stallTimeoutMs: initialData.stallTimeoutMs,
  });
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
    messageGenerationRef.current += 1;
    setRuns(initialData.runs);
    setNextRunCursor(initialData.nextRunCursor);
    setFlashMessage(null);
    setPendingActionId(null);
    setExpandedRunId(null);
    setLoadedMessageRunIds(new Set(initialData.loadedMessageRunIds));
    setMessageLoadErrorRunIds(new Set());
    setIsLoadingOlderRuns(false);
    setOlderRunsError(null);
    setConnectionState("connecting");
    setConnectionAnnouncement(null);
    hadDisconnectRef.current = false;
    channelHealthRef.current = {
      expandedMessages: null,
      runs: false,
      summaryMessages: null,
    };
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
      const generation = messageGenerationRef.current;
      setMessageLoadErrorRunIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(runId);
        return nextIds;
      });
      const { data, error } = await supabase
        .from("agent_run_messages")
        .select("agent_run_id, created_at, id, kind, message_md")
        .eq("agent_run_id", runId)
        .order("created_at", { ascending: false })
        .limit(WALLIE_RUN_MESSAGE_LIMIT);

      if (generation !== messageGenerationRef.current) return;
      if (error) {
        console.error("Wallie could not load run messages", {
          error,
          runId,
        });
        setMessageLoadErrorRunIds((currentIds) => new Set(currentIds).add(runId));
        return;
      }

      // Query returns newest-first; restore chronological order for the timeline.
      const rows = [...(data ?? [])].reverse();

      setRuns((currentRuns) => {
        let nextRuns = currentRuns;

        for (const row of rows) {
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

  const markConnectionDisconnected = useEffectEvent(() => {
    hadDisconnectRef.current = true;
    setConnectionState("disconnected");
    setConnectionAnnouncement(connectionStateCopy("disconnected"));
  });

  const markConnectionLive = useEffectEvent(() => {
    if (hadDisconnectRef.current) {
      setConnectionState("recovered");
      setConnectionAnnouncement(connectionStateCopy("recovered"));
      hadDisconnectRef.current = false;
      window.setTimeout(() => {
        setConnectionState((current) => (current === "recovered" ? "live" : current));
      }, 4_000);
      return;
    }

    setConnectionState("live");
  });

  const allRequiredChannelsLive = useEffectEvent(() => {
    const health = channelHealthRef.current;
    if (!health.runs) return false;
    if (health.expandedMessages === false) return false;
    if (health.summaryMessages === false) return false;
    return true;
  });

  const reportChannelStatus = useEffectEvent(
    (key: "expandedMessages" | "runs" | "summaryMessages", status: string) => {
      const mapped = mapRealtimeStatus(status);
      if (!mapped) return;

      if (mapped === "disconnected") {
        channelHealthRef.current[key] = false;
        markConnectionDisconnected();
        return;
      }

      if (mapped === "live") {
        channelHealthRef.current[key] = true;
        // Runs subscribe always reconciles history; connection copy waits until
        // every required channel (including message streams) is live.
        if (key === "runs") {
          void reconcileLatestRuns();
        }
        if (allRequiredChannelsLive()) {
          markConnectionLive();
        }
      }
    },
  );

  const handleRunRealtimeUpdate = useEffectEvent((row: Tables<"agent_runs">) => {
    setRuns((currentRuns) => {
      const previousRun = currentRuns.find((run) => run.id === row.id);

      return upsertWallieRun(
        currentRuns,
        mapAgentRunRow(row, memberIndex, previousRun?.messages ?? [], {
          attemptCount:
            previousRun?.attemptCount ??
            nextAttemptOrdinal(currentRuns, { id: row.id, stageId: row.stage_id }),
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

  useEffect(() => {
    const invalidate = () => {
      reconcileGenerationRef.current += 1;
      messageGenerationRef.current += 1;
    };
    window.addEventListener("pagehide", invalidate);
    return () => {
      invalidate();
      window.removeEventListener("pagehide", invalidate);
    };
  }, [session.id]);

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
      if (
        sessionIdRef.current !== requestSessionId ||
        generation !== reconcileGenerationRef.current
      ) {
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
        reportChannelStatus("runs", status);
      });

    return () => {
      channelHealthRef.current.runs = false;
      void supabase.removeChannel(runChannel);
    };
  }, [realtimeReady, session.id, supabase]);

  const summaryRun = useMemo(() => {
    return runs.find((run) => run.isActive) ?? runs[0] ?? null;
  }, [runs]);
  // Depend on the run id, not the run object — message upserts change object
  // identity and must not tear down/recreate the summary Realtime channel.
  const summaryRunId = summaryRun?.id ?? null;

  useEffect(() => {
    if (expandedRunId && !loadedMessageRunIds.has(expandedRunId)) {
      void loadRunMessages(expandedRunId);
    }
  }, [expandedRunId, loadRunMessages, loadedMessageRunIds]);

  // Keep the always-visible summary fed even when disclosure stays on an older run
  // (e.g. a new active run arrives while the user still has a prior run expanded).
  useEffect(() => {
    if (summaryRunId && !loadedMessageRunIds.has(summaryRunId)) {
      void loadRunMessages(summaryRunId);
    }
  }, [loadRunMessages, loadedMessageRunIds, summaryRunId]);

  useEffect(() => {
    if (!realtimeReady || !expandedRunId) {
      channelHealthRef.current.expandedMessages = null;
      return;
    }

    const runId = expandedRunId;
    channelHealthRef.current.expandedMessages = false;
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
        reportChannelStatus("expandedMessages", status);
      });

    return () => {
      channelHealthRef.current.expandedMessages = null;
      void supabase.removeChannel(messageChannel);
    };
  }, [expandedRunId, loadRunMessages, realtimeReady, supabase]);

  useEffect(() => {
    if (!realtimeReady || !summaryRunId || summaryRunId === expandedRunId) {
      channelHealthRef.current.summaryMessages = null;
      return;
    }

    const runId = summaryRunId;
    channelHealthRef.current.summaryMessages = false;
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
        reportChannelStatus("summaryMessages", status);
      });

    return () => {
      channelHealthRef.current.summaryMessages = null;
      void supabase.removeChannel(messageChannel);
    };
  }, [expandedRunId, loadRunMessages, realtimeReady, summaryRunId, supabase]);

  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: runs.some((run) => run.isActive),
    mode: initialData.mode,
    repository: initialData.repository,
    requiresVercelSandbox: initialData.requiresVercelSandbox,
    vercelSandboxConnection: initialData.vercelSandboxConnection,
  }).filter((reason) => reason.code !== "active_run");

  // An archived session accepts no new work. The backend rejects retries/runs
  // for archived sessions; mirror that here so the Retry button is disabled
  // rather than failing on click.
  const isArchived = Boolean(session.archivedAt);
  const historicalRuns = useMemo(
    () => runs.filter((run) => run.id !== summaryRunId),
    [runs, summaryRunId],
  );

  const handleRetryRun = useCallback(
    async (runId: string) => {
      setPendingActionId(runId);
      setFlashMessage(null);

      try {
        const payload = await queueRun(`/api/agent-runs/${runId}/retry`, {
          workspaceId: session.workspaceId,
        });

        const run = hydrateRequestedByMember(payload.run, memberIndex);

        setRuns((currentRuns) =>
          upsertWallieRun(currentRuns, {
            ...run,
            attemptCount: Math.max(
              run.attemptCount,
              nextAttemptOrdinal(currentRuns, { id: run.id, stageId: run.stageId }),
            ),
          }),
        );
        setExpandedRunId(null);
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

      {isArchived ? (
        <div
          aria-live="polite"
          className="rounded-[6px] border border-border bg-control-muted p-3 text-sm leading-5 text-muted"
          role="status"
        >
          This session is archived. Unarchive it to run Wallie again.
        </div>
      ) : null}

      {!isArchived && blockingReasons.length > 0 ? (
        <details
          className="rounded-[6px] border border-border bg-control-muted p-4 text-sm leading-6 text-muted"
          open={runs.length === 0 || Boolean(summaryRun?.canRetry)}
        >
          <summary className="cursor-pointer font-medium text-foreground">
            Setup needed before {runs.length === 0 ? "the first run" : "another run"}
          </summary>
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
        </details>
      ) : null}

      <div className="min-w-0 space-y-5">
        {summaryRun ? (
          <WallieRunCard
            key={summaryRun.id}
            actionPending={pendingActionId === summaryRun.id}
            branchName={
              summaryRun.sandboxId && summaryRun.stageSlug
                ? buildStageBranchName(session.id, summaryRun.stageSlug)
                : null
            }
            cancelLocked={pendingActionId !== null}
            connectionState={connectionState}
            isExpanded={expandedRunId === summaryRun.id}
            isPrimary
            messagesLoaded={loadedMessageRunIds.has(summaryRun.id)}
            messagesLoadFailed={messageLoadErrorRunIds.has(summaryRun.id)}
            nowMs={nowMs}
            onCancel={handleCancelRun}
            onRetry={handleRetryRun}
            onToggle={handleToggleRun}
            renderNow={renderNow}
            retryLocked={pendingActionId !== null || blockingReasons.length > 0 || isArchived}
            run={summaryRun}
            stallTimeoutMs={initialData.stallTimeoutMs}
          />
        ) : (
          <div className="rounded-[6px] border border-dashed border-border px-4 py-8 text-center text-sm leading-7 text-muted">
            No runs recorded yet.
          </div>
        )}

        {historicalRuns.length > 0 ? (
          <section aria-labelledby="previous-runs-heading" className="min-w-0">
            <h3 id="previous-runs-heading" className="ui-label">
              Previous runs
            </h3>
            <div className="mt-2 min-w-0 divide-y divide-border border-y border-border">
              {historicalRuns.map((run) => (
                <WallieRunCard
                  key={run.id}
                  actionPending={pendingActionId === run.id}
                  branchName={
                    run.sandboxId && run.stageSlug
                      ? buildStageBranchName(session.id, run.stageSlug)
                      : null
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
              ))}
            </div>
          </section>
        ) : null}
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
