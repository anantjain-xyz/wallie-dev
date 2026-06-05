import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { processPipelineJob } from "@/lib/pipeline/processor";

import type { WorkerConfig } from "./config";
import { sendHeartbeat } from "./heartbeat";

type AdminClient = SupabaseClient<Database>;
type AgentJobRow = Tables<"agent_jobs">;

export interface PollResult {
  jobId: string | null;
  outcome: "idle" | "error" | "success";
}

export interface PollRuntime {
  setActiveJobId?: (jobId: string | null) => void;
}

type ClaimNextResult =
  | { job: AgentJobRow; outcome: "claimed" }
  | { outcome: "error" }
  | { outcome: "idle" };

/**
 * Execute one poll cycle: find a queued job, check concurrency, claim it,
 * and process it.
 */
export async function pollOnce(
  admin: AdminClient,
  config: WorkerConfig,
  runtime: PollRuntime = {},
): Promise<PollResult> {
  const claimResult = await claimNextJobAtomic(admin, config.defaultConcurrencyLimit);
  if (claimResult.outcome === "error") {
    return { jobId: null, outcome: "error" };
  }

  if (claimResult.outcome === "idle") {
    return { jobId: null, outcome: "idle" };
  }

  const claimed = claimResult.job;

  // Report heartbeat with active job.
  runtime.setActiveJobId?.(claimed.id);
  await sendHeartbeat(admin, config.workerId, claimed.id);

  try {
    // Touch last_activity_at on any linked agent_runs so the stall detector
    // has a fresh baseline even if the processor crashes immediately.
    await admin
      .from("agent_runs")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("agent_job_id", claimed.id)
      .in("status", ["queued", "started", "running"]);

    // Process the job.
    try {
      await processClaimedJob(admin, claimed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Worker job processing failed";
      console.error("[worker] job processing error", { error: message, jobId: claimed.id });
      await markJobError(admin, claimed, message);
    }
  } finally {
    // Clear active job from heartbeat.
    runtime.setActiveJobId?.(null);
    await sendHeartbeat(admin, config.workerId, null);
  }

  return { jobId: claimed.id, outcome: "success" };
}

/**
 * Atomic concurrency-aware claim via Postgres RPC. The function selects and
 * claims the oldest ready job whose workspace still has capacity in one
 * transaction, so one saturated workspace cannot hide ready work for another.
 */
async function claimNextJobAtomic(
  admin: AdminClient,
  defaultConcurrencyLimit: number,
): Promise<ClaimNextResult> {
  const { data, error } = await admin.rpc("claim_next_agent_job", {
    default_concurrency_limit: defaultConcurrencyLimit,
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

async function processClaimedJob(admin: AdminClient, job: AgentJobRow): Promise<void> {
  await processPipelineJob({ admin, job });
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
