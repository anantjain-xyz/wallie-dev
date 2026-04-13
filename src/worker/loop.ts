import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { processPipelineJob } from "@/lib/pipeline/processor";
import { PIPELINE_JOB_TYPE } from "@/lib/pipeline/types";

import type { WorkerConfig } from "./config";
import { canAcceptJob } from "./concurrency";
import { sendHeartbeat } from "./heartbeat";

type AdminClient = SupabaseClient<Database>;
type AgentJobRow = Tables<"agent_jobs">;

const jobSelect =
  "id, workspace_id, issue_id, session_id, requested_by_member_id, trigger_type, status, attempt_count, last_error, dedupe_key, job_type, scheduled_at, started_at, finished_at, created_at, updated_at";

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

  // Try each candidate, respecting per-workspace concurrency.
  for (const candidate of candidates as AgentJobRow[]) {
    const allowed = await canAcceptJob(
      admin,
      candidate.workspace_id,
      config.defaultConcurrencyLimit,
    );

    if (!allowed) {
      continue;
    }

    // Attempt CAS claim: queued -> running.
    const claimed = await claimJob(admin, candidate);
    if (!claimed) {
      // Another worker claimed it first — try next candidate.
      continue;
    }

    // Report heartbeat with active job.
    await sendHeartbeat(admin, config.workerId, claimed.id);

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
 * CAS claim: update status from queued to running, increment attempt_count.
 * Returns the updated row if successful, null if another worker won the race.
 */
async function claimJob(admin: AdminClient, job: AgentJobRow): Promise<AgentJobRow | null> {
  const { data, error } = await admin
    .from("agent_jobs")
    .update({
      attempt_count: job.attempt_count + 1,
      last_error: null,
      started_at: job.started_at ?? new Date().toISOString(),
      status: "running",
    })
    .eq("id", job.id)
    .eq("status", "queued")
    .select(jobSelect)
    .maybeSingle();

  if (error) {
    console.error("[worker] claim failed", { error: error.message, jobId: job.id });
    return null;
  }

  return (data as AgentJobRow | null) ?? null;
}

/**
 * Route a claimed job to the appropriate processor.
 */
async function processClaimedJob(admin: AdminClient, job: AgentJobRow): Promise<void> {
  if (job.job_type === PIPELINE_JOB_TYPE) {
    await processPipelineJob({ admin, job });
    return;
  }

  // Non-pipeline jobs are not yet supported (Phase 2 will wire up the
  // agent runner). Mark as error so they don't block the queue.
  const errorMessage =
    "Non-pipeline jobs are not yet supported. Agent runner integration is planned for Phase 2.";

  await admin
    .from("agent_runs")
    .update({
      finished_at: new Date().toISOString(),
      status: "error" as const,
    })
    .eq("agent_job_id", job.id)
    .in("status", ["queued", "started", "running"]);

  await markJobError(admin, job, errorMessage);
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
