"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { IssueDetail, IssueMember } from "@/features/issues/types";
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
import type {
  WallieIssueData,
  WallieIssueRepository,
  WallieRun,
} from "@/features/wallie/types";
import type { Database, Tables } from "@/lib/supabase/database.types";
import {
  buildWallieBillingState,
  buildWallieBlockingReasons,
  formatWallieRunMode,
  inferWallieRunMode,
} from "@/lib/wallie/core";
import { workspaceSettingsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type FlashMessage = {
  kind: "error" | "info" | "success";
  text: string;
};

type IssueWalliePanelProps = {
  initialData: WallieIssueData;
  issue: IssueDetail;
  memberIndex: ReadonlyMap<string, IssueMember>;
  repositories: WallieIssueRepository[];
  supabase: SupabaseClient<Database>;
  workspaceSlug: string;
};

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
});

function flashToneClass(kind: FlashMessage["kind"]) {
  switch (kind) {
    case "error":
      return "border-rose-400/55 bg-rose-500/10 text-rose-950";
    case "info":
      return "border-sky-400/45 bg-sky-500/10 text-sky-950";
    default:
      return "border-emerald-400/45 bg-emerald-500/10 text-emerald-950";
  }
}

function runStatusToneClass(status: WallieRun["status"]) {
  switch (status) {
    case "queued":
      return "border-slate-400/45 bg-slate-500/10 text-slate-900";
    case "started":
      return "border-sky-400/45 bg-sky-500/10 text-sky-950";
    case "running":
      return "border-blue-400/45 bg-blue-500/10 text-blue-950";
    case "success":
      return "border-emerald-400/45 bg-emerald-500/10 text-emerald-950";
    case "error":
      return "border-rose-400/55 bg-rose-500/10 text-rose-950";
    case "canceled":
      return "border-amber-400/45 bg-amber-500/10 text-amber-950";
  }
}

function formatRunStatus(status: WallieRun["status"]) {
  return status.replaceAll("_", " ");
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

export function IssueWalliePanel({
  initialData,
  issue,
  memberIndex,
  repositories,
  supabase,
  workspaceSlug,
}: IssueWalliePanelProps) {
  const [runs, setRuns] = useState(initialData.runs);
  const [billing, setBilling] = useState(initialData.billing);
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() =>
    buildDefaultExpandedRunIds(initialData.runs),
  );
  const repository = issue.githubRepositoryId
    ? repositories.find(
        (candidateRepository) => candidateRepository.id === issue.githubRepositoryId,
      ) ?? null
    : null;
  const mode = inferWallieRunMode(issue.githubRepositoryId);

  useEffect(() => {
    setRuns(initialData.runs);
    setBilling(initialData.billing);
    setFlashMessage(null);
    setPendingActionId(null);
    setExpandedRunIds(buildDefaultExpandedRunIds(initialData.runs));
  }, [initialData.billing, initialData.runs, issue.id]);

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
    let didTransitionToSuccess = false;
    let isNewRun = false;

    setRuns((currentRuns) => {
      const previousRun = currentRuns.find((run) => run.id === row.id);

      isNewRun = !previousRun;
      didTransitionToSuccess =
        row.status === "success" && previousRun?.status !== "success";

      return upsertWallieRun(
        currentRuns,
        mapAgentRunRow(row, memberIndex, previousRun?.messages ?? []),
      );
    });

    if (didTransitionToSuccess) {
      setBilling((currentBilling) =>
        buildWallieBillingState({
          currentBillingCycleStartAt: currentBilling.currentBillingCycleStartAt,
          successfulRunsThisCycle: currentBilling.successfulRunsThisCycle + 1,
          tier: currentBilling.tier,
        }),
      );
    }

    if (isNewRun) {
      setExpandedRunIds((currentIds) => {
        const nextIds = new Set(currentIds);

        nextIds.add(row.id);
        return nextIds;
      });
      void loadRunMessages(row.id);
    }
  });

  const handleRunMessageRealtimeUpdate = useEffectEvent(
    (row: Tables<"agent_run_messages">) => {
      setRuns((currentRuns) =>
        upsertWallieRunMessage(currentRuns, {
          agentRunId: row.agent_run_id,
          message: mapAgentRunMessageRow(row),
        }),
      );
    },
  );

  useEffect(() => {
    const runChannel = supabase
      .channel(`wallie-runs:${issue.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          filter: `issue_id=eq.${issue.id}`,
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
  }, [issue.id, supabase]);

  useEffect(() => {
    const channels = runs.map((run) =>
      supabase
        .channel(`wallie-run-messages:${run.id}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            filter: `agent_run_id=eq.${run.id}`,
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
  }, [runs, supabase]);

  const blockingReasons = buildWallieBlockingReasons({
    billing,
    hasActiveRun: runs.some((run) => run.isActive),
    missingSecretKeys: initialData.missingSecretKeys,
    mode,
    repository,
  });
  const canEnqueue = blockingReasons.length === 0;

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

  async function handleRunWithWallie() {
    setPendingActionId("enqueue");
    setFlashMessage(null);

    try {
      const payload = await queueRun("/api/agent-runs", {
        issueId: issue.id,
        workspaceId: issue.workspaceId,
      });

      setRuns((currentRuns) => upsertWallieRun(currentRuns, payload.run));
      setExpandedRunIds((currentIds) => {
        const nextIds = new Set(currentIds);

        nextIds.add(payload.run.id);
        return nextIds;
      });
      setFlashMessage(
        payload.created
          ? {
              kind: "success",
              text: payload.processScheduled
                ? "Wallie queued the run and scheduled processing in the background."
                : "Wallie queued the run.",
            }
          : {
              kind: "info",
              text: "Wallie already has an active run on this issue.",
            },
      );
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Wallie could not queue that run.",
      });
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleRetryRun(runId: string) {
    setPendingActionId(runId);
    setFlashMessage(null);

    try {
      const payload = await queueRun(`/api/agent-runs/${runId}/retry`, {
        workspaceId: issue.workspaceId,
      });

      setRuns((currentRuns) => upsertWallieRun(currentRuns, payload.run));
      setExpandedRunIds((currentIds) => {
        const nextIds = new Set(currentIds);

        nextIds.add(payload.run.id);
        return nextIds;
      });
      setFlashMessage(
        payload.created
          ? {
              kind: "success",
              text: payload.processScheduled
                ? "Wallie queued the retry and scheduled processing in the background."
                : "Wallie queued the retry.",
            }
          : {
              kind: "info",
              text: "Wallie already has an active run on this issue.",
            },
      );
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Wallie could not retry that run.",
      });
    } finally {
      setPendingActionId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-border/80 bg-background/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-foreground">
              {formatWallieRunMode(mode)}
            </span>
            {repository ? (
              <a
                className="rounded-full border border-border/80 bg-background/80 px-3 py-1 text-xs font-semibold text-foreground transition hover:border-accent/40 hover:text-accent"
                href={repository.htmlUrl}
                rel="noreferrer"
                target="_blank"
              >
                {repository.fullName}
              </a>
            ) : (
              <span className="rounded-full border border-border/80 bg-background/80 px-3 py-1 text-xs font-semibold text-muted">
                No repository linked
              </span>
            )}
          </div>

          <p className="text-sm leading-6 text-muted">
            Gate F runs stay explicit. Use this panel to queue Wallie, inspect
            persisted run messages, and retry completed runs without exposing
            privileged queue writes to the browser.
          </p>
        </div>

        <button
          className="rounded-full border border-accent/45 bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-background transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={!canEnqueue || pendingActionId !== null}
          onClick={() => void handleRunWithWallie()}
          type="button"
        >
          {pendingActionId === "enqueue" ? "Queueing..." : "Run with Wallie"}
        </button>
      </div>

      {flashMessage ? (
        <div
          className={cn(
            "rounded-[1.35rem] border px-4 py-4 text-sm leading-6",
            flashToneClass(flashMessage.kind),
          )}
        >
          {flashMessage.text}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-[1.4rem] border border-border/70 bg-surface-strong/65 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            Secrets
          </p>
          <p className="mt-2 text-sm text-foreground">
            Required: {initialData.requiredSecretKeys.join(", ")}
          </p>
          <p className="mt-2 text-sm text-muted">
            {initialData.missingSecretKeys.length === 0
              ? "Ready"
              : `Missing: ${initialData.missingSecretKeys.join(", ")}`}
          </p>
        </div>

        <div className="rounded-[1.4rem] border border-border/70 bg-surface-strong/65 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            Billing
          </p>
          <p className="mt-2 text-sm text-foreground">
            Tier: <span className="font-semibold">{billing.tier}</span>
          </p>
          <p className="mt-2 text-sm text-muted">
            {billing.runLimit === null
              ? `${billing.successfulRunsThisCycle} successful runs this cycle`
              : `${billing.successfulRunsThisCycle} / ${billing.runLimit} successful runs this cycle`}
          </p>
        </div>

        <div className="rounded-[1.4rem] border border-border/70 bg-surface-strong/65 p-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
            Cycle
          </p>
          <p className="mt-2 text-sm text-foreground">
            Started{" "}
            <span className="font-semibold">
              {dateTimeFormatter.format(
                new Date(billing.currentBillingCycleStartAt),
              )}
            </span>
          </p>
          <p className="mt-2 text-sm text-muted">
            {billing.runLimit === null
              ? "Unlimited runs on this tier."
              : `${billing.runsRemaining ?? 0} runs remaining before Wallie blocks new work.`}
          </p>
        </div>
      </div>

      {blockingReasons.length > 0 ? (
        <div className="rounded-[1.5rem] border border-amber-400/45 bg-amber-500/10 p-5 text-sm leading-7 text-amber-950">
          <p className="font-semibold">Wallie cannot start a new run yet.</p>
          <ul className="mt-3 space-y-2">
            {blockingReasons.map((reason) => (
              <li key={reason.code}>{reason.message}</li>
            ))}
          </ul>
          <div className="mt-4">
            <Link
              className="font-semibold text-foreground transition hover:text-accent"
              href={workspaceSettingsPath(workspaceSlug)}
            >
              Open workspace settings
            </Link>
          </div>
        </div>
    ) : null}

      <div className="space-y-4">
        {runs.length === 0 ? (
          <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5 text-sm leading-7 text-muted">
            No Wallie runs yet. Queue one from this issue to create the first
            persisted timeline entry.
          </div>
        ) : (
          runs.map((run) => {
            const isExpanded = expandedRunIds.has(run.id);
            const triggeredByLabel =
              run.triggeredByMember?.fullName ??
              run.triggeredByMember?.username ??
              "Unknown member";

            return (
              <article
                key={run.id}
                className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <button
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
                          "rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em]",
                          runStatusToneClass(run.status),
                        )}
                      >
                        {formatRunStatus(run.status)}
                      </span>
                      <span className="rounded-full border border-border/80 bg-background/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-foreground">
                        {formatWallieRunMode(run.runType)}
                      </span>
                      <span className="rounded-full border border-border/80 bg-background/80 px-3 py-1 font-mono text-[11px] text-muted">
                        {run.modelProvider}/{run.modelName}
                      </span>
                    </div>

                    <p className="mt-3 text-sm font-semibold text-foreground">
                      Triggered by {triggeredByLabel}
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
                      className="rounded-full border border-border/80 bg-background/80 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={pendingActionId !== null}
                      onClick={() => void handleRetryRun(run.id)}
                      type="button"
                    >
                      {pendingActionId === run.id ? "Retrying..." : "Retry run"}
                    </button>
                  ) : null}
                </div>

                {isExpanded ? (
                  <div className="mt-4 space-y-3 border-t border-border/70 pt-4">
                    {run.messages.length === 0 ? (
                      <div className="rounded-[1.2rem] border border-border/70 bg-background/70 px-4 py-4 text-sm text-muted">
                        {run.isActive
                          ? "Wallie has claimed the run. Messages will appear here as the processor advances."
                          : "No persisted messages were recorded for this run."}
                      </div>
                    ) : (
                      run.messages.map((message) => (
                        <div
                          key={message.id}
                          className={cn(
                            "rounded-[1.2rem] border px-4 py-4 text-sm leading-7",
                            message.kind === "error"
                              ? "border-rose-400/55 bg-rose-500/10 text-rose-950"
                              : "border-border/70 bg-background/70 text-foreground",
                          )}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs uppercase tracking-[0.16em] text-muted">
                            <span>{message.kind}</span>
                            <span>
                              {dateTimeFormatter.format(
                                new Date(message.createdAt),
                              )}
                            </span>
                          </div>
                          <div className="mt-3 whitespace-pre-wrap">
                            {message.messageMd}
                          </div>
                        </div>
                      ))
                    )}
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
