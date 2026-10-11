import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { processPipelineJob } from "@/lib/pipeline/processor";

import type { WorkerConfig } from "./config";

type AdminClient = SupabaseClient<Database>;
type AgentJobRow = Tables<"agent_jobs">;

export type ClaimNextResult =
  | { job: AgentJobRow; outcome: "claimed" }
  | { outcome: "error" }
  | { outcome: "idle" };

/**
 * Atomic concurrency-aware claim via Postgres RPC. The function selects and
 * claims the oldest ready job whose workspace still has capacity in one
 * transaction, so one saturated workspace cannot hide ready work for another.
 * Returns at most one job per call; the scheduler calls it repeatedly to fill
 * its remaining capacity.
 */
export async function claimNextJob(
  admin: AdminClient,
  config: WorkerConfig,
): Promise<ClaimNextResult> {
  const { data, error } = await admin.rpc("claim_next_agent_job", {
    default_concurrency_limit: config.defaultConcurrencyLimit,
  });

  if (error) {
    console.error("[worker] atomic claim failed", { error: error.message });
    return { outcome: "error" };
  }

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return { outcome: "idle" };
  }

  return { job: row, outcome: "claimed" };
}

/**
 * Bound one captured queue claim independently of worker liveness. A provider
 * may ignore cancellation, so waiting for its promise is never the deadline.
 * Recovery retires only this attempt before releasing local scheduler capacity.
 */
export async function runClaimedJob(
  admin: AdminClient,
  job: AgentJobRow,
  options: { timeoutMs?: number; recoveryTimeoutMs?: number } = {},
): Promise<void> {
  const jobId = job.id;
  const attemptCount = job.attempt_count;
  const controller = new AbortController();
  const deadlineAt = new Date(Date.now() + (options.timeoutMs ?? 3_600_000)).toISOString();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutMessage: string | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `Worker attempt exceeded its ${options.timeoutMs ?? 3_600_000}ms deadline.`,
      );
      timeoutMessage = error.message;
      controller.abort(error);
      reject(error);
    }, options.timeoutMs ?? 3_600_000);
  });
  try {
    await Promise.race([
      processPipelineJob({ admin, job, deadlineAt, signal: controller.signal }),
      deadline,
    ]);
  } catch (error) {
    controller.abort(error);
    const message = error instanceof Error ? error.message : "Worker job processing failed";
    console.error("[worker] job processing error", { error: message, jobId: job.id });
    const recovery = new AbortController();
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const recoveryDeadline = new Promise<never>((_, reject) => {
        recoveryTimer = setTimeout(() => {
          const error = new Error(
            "Attempt recovery exceeded its deadline; stall recovery will retry.",
          );
          recovery.abort(error);
          reject(error);
        }, options.recoveryTimeoutMs ?? 10_000);
      });
      await Promise.race([
        retireAttempt(admin, {
          jobId,
          attemptCount,
          message,
          workspaceId: job.workspace_id,
          historyMessage: timeoutMessage ?? "Worker job processing failed.",
          signal: recovery.signal,
        }),
        recoveryDeadline,
      ]);
    } catch (recoveryError) {
      // A database failure is not permission to bypass the ownership guard.
      console.error("[worker] failed to record processing error", {
        error: recoveryError,
        jobId: job.id,
        attemptCount,
      });
    } finally {
      clearTimeout(recoveryTimer);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function retireAttempt(
  admin: AdminClient,
  input: {
    jobId: string;
    attemptCount: number;
    message: string;
    workspaceId: string;
    historyMessage: string;
    signal: AbortSignal;
  },
): Promise<void> {
  // A start RPC already in flight may bind a run after the first lookup. A
  // runless failure cannot steal that run; re-read the same attempt once. If
  // failure wins first, start's job-state guard rejects the late start instead.
  for (let lookup = 0; lookup < 2; lookup += 1) {
    input.signal.throwIfAborted();
    const { data: run, error: lookupError } = await admin
      .from("agent_runs")
      .select("id")
      .eq("agent_job_id", input.jobId)
      .eq("attempt_count", input.attemptCount)
      .abortSignal(input.signal)
      .maybeSingle();
    if (lookupError) throw lookupError;
    input.signal.throwIfAborted();
    const { data: result, error } = await admin
      .rpc("fail_session_job_attempt", {
        p_job_id: input.jobId,
        p_attempt_count: input.attemptCount,
        p_run_id: run?.id,
        p_error: input.message,
        p_retry: false,
        p_max_retries: 0,
      })
      .abortSignal(input.signal);
    if (error) throw error;
    if (run && result === "error") {
      input.signal.throwIfAborted();
      const { error: historyError } = await admin
        .from("agent_run_messages")
        .insert({
          agent_run_id: run.id,
          workspace_id: input.workspaceId,
          kind: "error",
          message_md: input.historyMessage,
        })
        .abortSignal(input.signal);
      if (historyError) throw historyError;
    }
    if (run || result !== "stale") return;
  }
}
