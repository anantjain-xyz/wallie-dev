import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { hasRecoverableSandboxSource } from "@/lib/sandbox";
import type { SandboxConnection } from "@/lib/sandbox/types";

const FRESH_WORKER_HEARTBEAT_MS = 60_000;

/**
 * Retain failed source until the provider proves its original filesystem is gone.
 * Callers hold the connection mutation lease; elapsed TTL alone is not proof.
 */
export async function hasRetainedSandboxSource(
  admin: SupabaseClient<Database>,
  input: { connection: SandboxConnection; workspaceId: string },
) {
  const retained = () =>
    admin
      .from("agent_runs")
      .select("id, sandbox_id, status")
      .eq("workspace_id", input.workspaceId)
      .eq("sandbox_provider", input.connection.provider)
      .eq("sandbox_connection_revision", input.connection.revision)
      .eq("source_recovery_required", true);
  const { data, error } = await retained();
  if (error) throw error;
  if (!data?.length) return false;

  for (const { id, sandbox_id: sandboxId, status } of data) {
    if (
      !sandboxId ||
      sandboxId.startsWith("provisioning:") ||
      !["success", "error", "canceled"].includes(status)
    )
      return true;
    if (await hasRecoverableSandboxSource(sandboxId, input.connection)) return true;

    // Do not release a new owner if recovery replaced the sandbox during the read.
    const { error: clearError } = await admin
      .from("agent_runs")
      .update({ source_recovery_required: false })
      .eq("id", id)
      .eq("workspace_id", input.workspaceId)
      .eq("sandbox_provider", input.connection.provider)
      .eq("sandbox_connection_revision", input.connection.revision)
      .eq("sandbox_id", sandboxId)
      .eq("status", status)
      .eq("source_recovery_required", true);
    if (clearError) throw clearError;
  }
  // A conditional write can lose a race; credentials remain owned in that case.
  const { data: remaining, error: remainingError } = await retained();
  if (remainingError) throw remainingError;
  return !!remaining?.length;
}

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
