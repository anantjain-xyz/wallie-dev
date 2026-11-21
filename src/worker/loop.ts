import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  BrowserScreenshotRuntime,
  BrowserVideoRuntime,
} from "@/lib/validation-evidence/browser-contract";
import { workerRunCaptureEnvSchema } from "@/env/worker";
import type { Database, Tables } from "@/lib/supabase/database.types";
import type { AttemptWorkerRuntime } from "@/lib/pipeline/attempt-manifest";
import { processPipelineJob } from "@/lib/pipeline/processor";
import { WorkerAttemptDeadlineError } from "@/lib/pipeline/worker-attempt-deadline";

import type { WorkerConfig } from "./config";

type AdminClient = SupabaseClient<Database>;
type AgentJobRow = Tables<"agent_jobs">;

export type ClaimNextResult =
  | { job: AgentJobRow; outcome: "claimed" }
  | { outcome: "error" }
  | { outcome: "idle" };

/**
 * Atomic concurrency-aware claim via Postgres RPC. The function selects and
 * claims a ready job whose workspace still has capacity in one transaction,
 * preferring production work. One saturated workspace cannot hide ready work
 * for another.
 * Returns at most one job per call; the scheduler calls it repeatedly to fill
 * its remaining capacity.
 */
export async function claimNextJob(
  admin: AdminClient,
  config: WorkerConfig,
  { acceptBenchmarkTrials = true }: { acceptBenchmarkTrials?: boolean } = {},
): Promise<ClaimNextResult> {
  const { data, error } = await admin.rpc("claim_next_agent_job", {
    default_concurrency_limit: config.defaultConcurrencyLimit,
    accept_benchmark_trials: acceptBenchmarkTrials,
    p_worker_runtime: "node",
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
  options: {
    captureOrderedEvents?: boolean;
    timeoutMs?: number;
    recoveryTimeoutMs?: number;
    deadlineAt?: string;
    workerRuntime?: AttemptWorkerRuntime;
    browserRuntime?: BrowserScreenshotRuntime;
    browserVideoRuntime?: BrowserVideoRuntime;
  } = {},
): Promise<void> {
  const jobId = job.id;
  const attemptCount = job.attempt_count;
  const controller = new AbortController();
  const now = Date.now();
  const deadlineMs = Math.min(
    now + (options.timeoutMs ?? 1_800_000),
    options.deadlineAt ? Date.parse(options.deadlineAt) : Infinity,
  );
  const deadlineAt = new Date(deadlineMs).toISOString();
  const timeoutMs = Math.max(0, deadlineMs - now);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs === 0)
      throw new WorkerAttemptDeadlineError("Worker attempt deadline expired before execution.");
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new WorkerAttemptDeadlineError(
          `Worker attempt exceeded its ${timeoutMs}ms deadline.`,
        );
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const captureOrderedEvents =
      options.captureOrderedEvents ??
      workerRunCaptureEnvSchema.parse(process.env).WALLIE_ORDERED_RUN_CAPTURE_ENABLED;
    await Promise.race([
      processPipelineJob({
        admin,
        job,
        captureOrderedEvents,
        deadlineAt,
        signal: controller.signal,
        workerRuntime: options.workerRuntime ?? "node",
        ...(options.browserRuntime ? { browserRuntime: options.browserRuntime } : {}),
        ...(options.browserVideoRuntime
          ? { browserVideoRuntime: options.browserVideoRuntime }
          : {}),
      }),
      deadline,
    ]);
  } catch (error) {
    controller.abort(error);
    const deadlineElapsed = error instanceof WorkerAttemptDeadlineError;
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
          deadlineElapsed,
          historyMessage: deadlineElapsed ? message : "Worker job processing failed.",
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
    deadlineElapsed: boolean;
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
    // A processor rejection may follow a committed intent and a lost database
    // reply. Preserve that completed work until its original deadline expires.
    const identity = {
      p_job_id: input.jobId,
      p_attempt_count: input.attemptCount,
      p_run_id: run?.id,
      p_error: input.message,
    };
    const failure = input.deadlineElapsed
      ? admin.rpc("fail_deadline_session_job_attempt", identity)
      : admin.rpc("fail_stalled_session_job_attempt", {
          ...identity,
          p_retry: false,
          p_max_retries: 0,
        });
    const { data: result, error } = await failure.abortSignal(input.signal);
    if (error) throw error;
    if (run && result === "error") {
      input.signal.throwIfAborted();
      const { error: historyError } = await admin
        .from("agent_run_messages")
        .insert({
          agent_run_id: run.id,
          workspace_id: input.workspaceId,
          kind: "worker_error",
          message_md: input.historyMessage,
        })
        .abortSignal(input.signal);
      if (historyError) throw historyError;
    }
    if (run || result !== "stale") return;
  }
}
