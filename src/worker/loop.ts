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

/** Process one captured queue claim. Recovery can only retire that attempt. */
export async function runClaimedJob(admin: AdminClient, job: AgentJobRow): Promise<void> {
  const jobId = job.id;
  const attemptCount = job.attempt_count;
  try {
    await processPipelineJob({ admin, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker job processing failed";
    console.error("[worker] job processing error", { error: message, jobId: job.id });
    try {
      // The processor may have failed after binding or publishing its run. Look
      // up only this captured attempt; never borrow a replacement's run identity.
      const { data: run, error: lookupError } = await admin
        .from("agent_runs")
        .select("id")
        .eq("agent_job_id", jobId)
        .eq("attempt_count", attemptCount)
        .maybeSingle();
      if (lookupError) throw lookupError;
      const { error: recoveryError } = await admin.rpc("fail_session_job_attempt", {
        p_job_id: jobId,
        p_attempt_count: attemptCount,
        p_run_id: run?.id,
        p_error: message,
        p_retry: false,
        p_max_retries: 0,
      });
      if (recoveryError) throw recoveryError;
    } catch (recoveryError) {
      // A database failure is not permission to bypass the ownership guard.
      console.error("[worker] failed to record processing error", {
        error: recoveryError,
        jobId: job.id,
        attemptCount,
      });
    }
  }
}
