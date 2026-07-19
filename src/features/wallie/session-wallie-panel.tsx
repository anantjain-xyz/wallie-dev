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
import { workspaceSettingsCategoryPath, workspaceSettingsPath } from "@/lib/routes";
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
  const sessionIdRef = useRef(session.id);
  const reconcileGenerationRef = useRef(0);
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
    setExpandedRunId(null);
    setLoadedMessageRunIds(new Set(initialData.loadedMessageRunIds));
    setMessageLoadErrorRunIds(new Set());
    setIsLoadingOlderRuns(false);
    setOlderRunsError(null);
  }, [initialData.loadedMessageRunIds, initialData.nextRunCursor, initialData.runs, session.id]);

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
        mapAgentRunRow(row, memberIndex, previousRun?.messages ?? []),
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
        if (status === "SUBSCRIBED") {
          void reconcileLatestRuns();
        }
      });

    return () => {
      void supabase.removeChannel(runChannel);
    };
  }, [realtimeReady, session.id, supabase]);

  useEffect(() => {
    if (expandedRunId && !loadedMessageRunIds.has(expandedRunId)) {
      void loadRunMessages(expandedRunId);
    }
  }, [expandedRunId, loadRunMessages, loadedMessageRunIds]);

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
    <div className="space-y-5">
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
              <Link
                className={interactiveLinkClass}
                href={`${workspaceSettingsCategoryPath(workspaceSlug, "agent-execution")}#runtime`}
              >
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

      <div className="divide-y divide-border border-y border-border">
        {runs.length === 0 ? (
          <div className="py-5 text-sm leading-7 text-muted">No runs recorded yet.</div>
        ) : (
          runs.map((run) => (
            <WallieRunCard
              key={run.id}
              actionPending={pendingActionId === run.id}
              cancelLocked={pendingActionId !== null}
              isExpanded={expandedRunId === run.id}
              messagesLoaded={loadedMessageRunIds.has(run.id)}
              messagesLoadFailed={messageLoadErrorRunIds.has(run.id)}
              onCancel={handleCancelRun}
              onRetry={handleRetryRun}
              onToggle={handleToggleRun}
              renderNow={renderNow}
              retryLocked={pendingActionId !== null || blockingReasons.length > 0 || isArchived}
              run={run}
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

type WallieRunCardProps = {
  actionPending: boolean;
  cancelLocked: boolean;
  isExpanded: boolean;
  messagesLoaded: boolean;
  messagesLoadFailed: boolean;
  onCancel: (runId: string) => Promise<void>;
  onRetry: (runId: string) => Promise<void>;
  onToggle: (runId: string) => void;
  renderNow: string;
  retryLocked: boolean;
  run: WallieRun;
};

const WallieRunCard = memo(function WallieRunCard({
  actionPending,
  cancelLocked,
  isExpanded,
  messagesLoaded,
  messagesLoadFailed,
  onCancel,
  onRetry,
  onToggle,
  renderNow,
  retryLocked,
  run,
}: WallieRunCardProps) {
  const runDetailsId = `wallie-run-details-${run.id}`;

  return (
    <article
      aria-busy={run.isActive}
      className={cn("py-5", !isExpanded && !run.isActive && "run-history-group")}
      data-run-id={run.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <button
          aria-controls={runDetailsId}
          aria-expanded={isExpanded}
          className="min-w-0 flex-1 text-left"
          onClick={() => onToggle(run.id)}
          type="button"
        >
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Status value={agentRunStatusValue(run.status)} />
            <dl className="flex flex-wrap gap-x-3 gap-y-1 type-annotation text-muted">
              <div className="flex gap-1">
                <dt>Stage</dt>
                <dd className="text-foreground">{formatStageRunLabel(run)}</dd>
              </div>
              <div className="flex gap-1">
                <dt>Model</dt>
                <dd className="font-mono text-foreground">
                  {run.modelProvider}/{run.modelName}
                </dd>
              </div>
            </dl>
          </div>

          <p className="mt-3 text-sm font-semibold text-foreground">
            Requested by {formatRequestedBy(run)}
          </p>
          <p className="mt-1 text-sm text-muted">
            Created{" "}
            <TimeDisplay absoluteStyle="short" initialNow={renderNow} value={run.createdAt} />
            {run.startedAt ? (
              <>
                {" · Started "}
                <TimeDisplay absoluteStyle="short" initialNow={renderNow} value={run.startedAt} />
                {" · Elapsed "}
                <TimeDisplay
                  active={run.isActive}
                  endValue={run.finishedAt}
                  initialNow={renderNow}
                  value={run.startedAt}
                  variant="elapsed"
                />
              </>
            ) : null}
            {run.finishedAt ? (
              <>
                {" · Finished "}
                <TimeDisplay absoluteStyle="short" initialNow={renderNow} value={run.finishedAt} />
              </>
            ) : null}
          </p>
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
        <div id={runDetailsId} className="mt-4 space-y-3 border-t border-border/70 pt-4">
          {run.messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                "rounded-[6px] border px-4 py-4 text-sm leading-7",
                message.kind === "error"
                  ? "border-danger/20 bg-danger-soft text-danger"
                  : "border-border bg-control-muted text-foreground",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 type-annotation text-muted">
                <span>{message.kind}</span>
                <TimeDisplay
                  absoluteStyle="short"
                  initialNow={renderNow}
                  value={message.createdAt}
                />
              </div>
              <div className="mt-3 whitespace-pre-wrap">{message.messageMd}</div>
            </div>
          ))}
          {run.messages.length === 0 && !run.isActive && messagesLoadFailed ? (
            <div
              aria-live="polite"
              className="rounded-[6px] bg-danger-soft px-4 py-4 text-sm text-danger"
              role="status"
            >
              Could not load run messages. Collapse and expand this run to retry.
            </div>
          ) : null}
          {run.messages.length === 0 && !run.isActive && !messagesLoaded && !messagesLoadFailed ? (
            <div
              aria-live="polite"
              className="rounded-[6px] bg-control-muted px-4 py-4 text-sm text-muted"
              role="status"
            >
              Loading run messages...
            </div>
          ) : null}
          {run.messages.length === 0 && !run.isActive && messagesLoaded ? (
            <div
              aria-live="polite"
              className="rounded-[6px] bg-control-muted px-4 py-4 text-sm text-muted"
              role="status"
            >
              No persisted messages were recorded for this run.
            </div>
          ) : null}
          {run.isActive ? <RunProgressRow /> : null}
        </div>
      ) : null}
    </article>
  );
});

function RunProgressRow() {
  return (
    <div
      aria-busy
      aria-live="polite"
      className="rounded-[6px] bg-control-muted px-4 py-4 text-sm text-muted"
      role="status"
    >
      <span className="flex items-center gap-2">
        <Spinner />
        <span>Wallie is working</span>
      </span>
    </div>
  );
}
