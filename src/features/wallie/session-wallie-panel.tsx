"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useMemo, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import { Spinner } from "@/components/shared/spinner";
import type { WorkspaceMember } from "@/features/workspace-members/types";
import type {
  AgentRunActionErrorResponse,
  AgentRunActionResponse,
} from "@/features/wallie/contracts";
import {
  mapAgentRunMessageRow,
  mapAgentRunRow,
  upsertWallieRun,
  upsertWallieRunMessage,
} from "@/features/wallie/data";
import type { WallieSessionData, WallieRun } from "@/features/wallie/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { buildWallieBlockingReasons } from "@/features/wallie/utils";
import { formatSentenceCaseLabel } from "@/lib/labels";
import { workspaceSettingsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type FlashMessage = {
  kind: "error" | "info" | "success";
  text: string;
};

export type WalliePanelSession = {
  id: string;
  workspaceId: string;
};

type SessionWalliePanelProps = {
  initialData: WallieSessionData;
  session: WalliePanelSession;
  memberIndex: ReadonlyMap<string, WorkspaceMember>;
  supabase: SupabaseClient<Database>;
  workspaceSlug: string;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

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

function runStatusToneClass(status: WallieRun["status"]) {
  switch (status) {
    case "queued":
      return "border-border-strong bg-surface-muted text-muted";
    case "started":
      return "border-accent/20 bg-accent-soft text-accent";
    case "running":
      return "border-accent/20 bg-accent-soft text-accent";
    case "success":
      return "border-success/20 bg-success-soft text-success";
    case "error":
      return "border-danger/20 bg-danger-soft text-danger";
    case "canceled":
      return "border-warning/20 bg-warning-soft text-warning";
  }
}

function formatRunStatus(status: WallieRun["status"]) {
  return formatSentenceCaseLabel(status);
}

function buildDefaultExpandedRunIds(runs: readonly WallieRun[]) {
  const nextIds = new Set<string>();
  const activeRun = runs.find((run) => run.isActive);

  if (activeRun) {
    nextIds.add(activeRun.id);
    return nextIds;
  }

  if (runs[0]) {
    nextIds.add(runs[0].id);
  }

  return nextIds;
}

function actionErrorMessage(payload: AgentRunActionErrorResponse | null) {
  if (!payload) {
    return "Wallie could not queue that run.";
  }

  return payload.error;
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
  session,
  memberIndex,
  supabase,
  workspaceSlug,
}: SessionWalliePanelProps) {
  const [runs, setRuns] = useState(initialData.runs);
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() =>
    buildDefaultExpandedRunIds(initialData.runs),
  );
  const runIdsKey = useMemo(
    () =>
      runs
        .map((run) => run.id)
        .sort()
        .join(","),
    [runs],
  );

  useEffect(() => {
    setRuns(initialData.runs);
    setFlashMessage(null);
    setPendingActionId(null);
    setExpandedRunIds(buildDefaultExpandedRunIds(initialData.runs));
  }, [initialData.runs, session.id]);

  async function loadRunMessages(runId: string) {
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
  }

  const handleRunRealtimeUpdate = useEffectEvent((row: Tables<"agent_runs">) => {
    let isNewRun = false;

    setRuns((currentRuns) => {
      const previousRun = currentRuns.find((run) => run.id === row.id);

      isNewRun = !previousRun;

      return upsertWallieRun(
        currentRuns,
        mapAgentRunRow(row, memberIndex, previousRun?.messages ?? []),
      );
    });

    if (isNewRun) {
      setExpandedRunIds((currentIds) => {
        const nextIds = new Set(currentIds);

        nextIds.add(row.id);
        return nextIds;
      });
      void loadRunMessages(row.id);
    }
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
      .subscribe();

    return () => {
      void supabase.removeChannel(runChannel);
    };
  }, [session.id, supabase]);

  useEffect(() => {
    const runIds = runIdsKey ? runIdsKey.split(",") : [];
    const channels = runIds.map((runId) =>
      supabase
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
        .subscribe(),
    );

    return () => {
      for (const channel of channels) {
        void supabase.removeChannel(channel);
      }
    };
  }, [runIdsKey, supabase]);

  const blockingReasons = buildWallieBlockingReasons({
    hasActiveRun: runs.some((run) => run.isActive),
    missingSecretKeys: initialData.missingSecretKeys,
    mode: initialData.mode,
    repository: initialData.repository,
    vercelSandboxConnection: initialData.vercelSandboxConnection,
  }).filter((reason) => reason.code !== "active_run");

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

  async function handleRetryRun(runId: string) {
    setPendingActionId(runId);
    setFlashMessage(null);

    try {
      const payload = await queueRun(`/api/agent-runs/${runId}/retry`, {
        workspaceId: session.workspaceId,
      });

      const run = hydrateRequestedByMember(payload.run, memberIndex);

      setRuns((currentRuns) => upsertWallieRun(currentRuns, run));
      setExpandedRunIds((currentIds) => {
        const nextIds = new Set(currentIds);

        nextIds.add(run.id);
        return nextIds;
      });
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
  }

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
        <div className="ui-subpanel p-4">
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

      <div className="space-y-4">
        {runs.length === 0 ? (
          <div className="ui-subpanel p-5 text-sm leading-7 text-muted">No runs recorded yet.</div>
        ) : (
          runs.map((run) => {
            const isExpanded = expandedRunIds.has(run.id);
            const runDetailsId = `wallie-run-details-${run.id}`;
            const requestedByLabel = formatRequestedBy(run);
            const runIsBusy = run.isActive;

            return (
              <article key={run.id} aria-busy={runIsBusy} className="ui-subpanel p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <button
                    aria-controls={runDetailsId}
                    aria-expanded={isExpanded}
                    className="min-w-0 flex-1 text-left"
                    onClick={() =>
                      setExpandedRunIds((currentIds) => {
                        const nextIds = new Set(currentIds);

                        if (nextIds.has(run.id)) {
                          nextIds.delete(run.id);
                        } else {
                          nextIds.add(run.id);
                        }

                        return nextIds;
                      })
                    }
                    type="button"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
                          runStatusToneClass(run.status),
                        )}
                      >
                        {runIsBusy ? <Spinner /> : null}
                        {formatRunStatus(run.status)}
                      </span>
                      <span className="ui-pill">{formatStageRunLabel(run)}</span>
                      <span className="ui-pill font-mono text-muted">
                        {run.modelProvider}/{run.modelName}
                      </span>
                    </div>

                    <p className="mt-3 text-sm font-semibold text-foreground">
                      Requested by {requestedByLabel}
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      Created {dateTimeFormatter.format(new Date(run.createdAt))}
                      {run.startedAt
                        ? ` · Started ${dateTimeFormatter.format(new Date(run.startedAt))}`
                        : ""}
                      {run.finishedAt
                        ? ` · Finished ${dateTimeFormatter.format(new Date(run.finishedAt))}`
                        : ""}
                    </p>
                  </button>

                  {run.canRetry ? (
                    <button
                      className="ui-button"
                      disabled={pendingActionId !== null || blockingReasons.length > 0}
                      onClick={() => void handleRetryRun(run.id)}
                      type="button"
                    >
                      {pendingActionId === run.id ? "Retrying…" : "Retry Run"}
                    </button>
                  ) : null}
                </div>

                {isExpanded ? (
                  <div id={runDetailsId} className="mt-4 space-y-3 border-t border-border/70 pt-4">
                    {run.messages.length > 0
                      ? run.messages.map((message) => (
                          <div
                            key={message.id}
                            className={cn(
                              "rounded-[6px] border px-4 py-4 text-sm leading-7",
                              message.kind === "error"
                                ? "border-danger/20 bg-danger-soft text-danger"
                                : "border-border bg-surface-muted text-foreground",
                            )}
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
                              <span>{message.kind}</span>
                              <span>{dateTimeFormatter.format(new Date(message.createdAt))}</span>
                            </div>
                            <div className="mt-3 whitespace-pre-wrap">{message.messageMd}</div>
                          </div>
                        ))
                      : null}
                    {run.messages.length === 0 && !runIsBusy ? (
                      <div
                        aria-live="polite"
                        className="ui-muted-panel px-4 py-4 text-sm text-muted"
                        role="status"
                      >
                        No persisted messages were recorded for this run.
                      </div>
                    ) : null}
                    {runIsBusy ? <RunProgressRow /> : null}
                  </div>
                ) : null}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

function RunProgressRow() {
  return (
    <div
      aria-busy
      aria-live="polite"
      className="ui-muted-panel px-4 py-4 text-sm text-muted"
      role="status"
    >
      <span className="flex items-center gap-2">
        <Spinner />
        <span>Wallie is working</span>
      </span>
    </div>
  );
}
