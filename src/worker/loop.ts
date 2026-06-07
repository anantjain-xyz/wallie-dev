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

  return { job: row as AgentJobRow, outcome: "claimed" };
}

/**
 * Process a single already-claimed job to completion. Touches the linked runs'
 * activity so the stall detector has a fresh baseline even if the processor
 * crashes immediately, then runs the pipeline. Never rejects: a processing
 * failure is recorded via markJobError so one job cannot abort its siblings or
 * the scheduler loop.
 */
export async function runClaimedJob(admin: AdminClient, job: AgentJobRow): Promise<void> {
  // Touch last_activity_at on any linked agent_runs so the stall detector has
  // a fresh baseline even if the processor crashes immediately.
  await admin
    .from("agent_runs")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("agent_job_id", job.id)
    .in("status", ["queued", "started", "running"]);

  try {
    await processPipelineJob({ admin, job });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Worker job processing failed";
    console.error("[worker] job processing error", { error: message, jobId: job.id });
    await markJobError(admin, job, message);
  }
}

async function markJobError(
  admin: AdminClient,
  job: AgentJobRow,
  errorMessage: string,
): Promise<void> {
  await admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      last_error: errorMessage,
      status: "error",
    })
    .eq("id", job.id);
}
