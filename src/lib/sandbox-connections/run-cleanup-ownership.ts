import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

const FRESH_WORKER_HEARTBEAT_MS = 60_000;

/** Successful runs can still need their sandbox for PR delivery after publication. */
export async function loadSandboxProtectedJobAttempts(
  admin: SupabaseClient<Database>,
  jobIds: string[],
): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();

  const { data, error } = await admin
    .from("agent_jobs")
    .select("id, attempt_count, status")
    .in("id", [...new Set(jobIds)])
    .in("status", ["queued", "started", "running", "success"]);
  if (error) throw error;

  const jobs = data ?? [];
  const protectedAttempts = new Map(
    jobs.filter((job) => job.status !== "success").map((job) => [job.id, job.attempt_count]),
  );
  if (!jobs.some((job) => job.status === "success")) return protectedAttempts;

  // Recovery can close a published job while its worker still finishes PR work.
  // A heartbeat protects only the job's current attempt, never older run rows.
  const { data: heartbeats, error: heartbeatError } = await admin
    .from("worker_heartbeats")
    .select("active_job_ids")
    .gte("last_heartbeat_at", new Date(Date.now() - FRESH_WORKER_HEARTBEAT_MS).toISOString());
  if (heartbeatError) throw heartbeatError;

  const workerJobIds = new Set((heartbeats ?? []).flatMap((row) => row.active_job_ids));
  for (const job of jobs) {
    if (job.status === "success" && workerJobIds.has(job.id)) {
      protectedAttempts.set(job.id, job.attempt_count);
    }
  }
  return protectedAttempts;
}
