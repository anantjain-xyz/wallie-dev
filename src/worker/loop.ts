import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { processPipelineJob } from "@/lib/pipeline/processor";

import type { WorkerConfig } from "./config";
import { sendHeartbeat } from "./heartbeat";

type AdminClient = SupabaseClient<Database>;
type AgentJobRow = Tables<"agent_jobs">;

const jobSelect =
  "id, workspace_id, session_id, requested_by_member_id, trigger_type, status, attempt_count, last_error, dedupe_key, job_type, scheduled_at, started_at, finished_at, created_at, updated_at";

export interface PollResult {
  jobId: string | null;
  outcome: "claimed" | "concurrency_limited" | "idle" | "error" | "success";
}

/**
 * Execute one poll cycle: find a queued job, check concurrency, claim it,
 * and process it.
 */
export async function pollOnce(admin: AdminClient, config: WorkerConfig): Promise<PollResult> {
  // Fetch up to 10 queued candidates, oldest first.
  const { data: candidates, error: fetchError } = await admin
    .from("agent_jobs")
    .select(jobSelect)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(10);

  if (fetchError) {
    console.error("[worker] failed to fetch candidates", { error: fetchError.message });
    return { jobId: null, outcome: "error" };
  }

  if (!candidates || candidates.length === 0) {
    return { jobId: null, outcome: "idle" };
  }

  // Try each candidate with an atomic concurrency-aware claim.
  // The RPC checks the workspace's concurrency limit and CAS-claims the job
  // in a single transaction, preventing two workers from both observing
  // capacity and then each claiming a different job.
  for (const candidate of candidates as AgentJobRow[]) {
    const claimed = await claimJobAtomic(admin, candidate.id, config.defaultConcurrencyLimit);
    if (!claimed) {
      // Either at capacity or another worker claimed it — try next.
      continue;
    }

    // Report heartbeat with active job.
    await sendHeartbeat(admin, config.workerId, claimed.id);

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

    // Clear active job from heartbeat.
    await sendHeartbeat(admin, config.workerId, null);

    return { jobId: claimed.id, outcome: "success" };
  }

  // All candidates were concurrency-limited or claimed by others.
  return { jobId: null, outcome: "concurrency_limited" };
}

/**
 * Atomic concurrency-aware claim via Postgres RPC.
 * The function checks the workspace's concurrency limit and CAS-claims the
 * job in a single transaction, so two workers cannot both observe capacity
 * and then each claim a different job.
 */
async function claimJobAtomic(
  admin: AdminClient,
  jobId: string,
  defaultConcurrencyLimit: number,
): Promise<AgentJobRow | null> {
  const { data, error } = await admin.rpc("claim_agent_job", {
    target_job_id: jobId,
    default_concurrency_limit: defaultConcurrencyLimit,
  });

  if (error) {
    console.error("[worker] atomic claim failed", { error: error.message, jobId });
    return null;
  }

  const row = Array.isArray(data) ? data[0] : null;
  return (row as AgentJobRow | null) ?? null;
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
