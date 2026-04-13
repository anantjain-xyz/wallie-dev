import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

/**
 * Register this worker in the heartbeats table on startup.
 * Uses upsert so a restarted worker reclaims its row.
 */
export async function registerWorker(admin: AdminClient, workerId: string): Promise<void> {
  const { error } = await admin.from("worker_heartbeats").upsert(
    {
      worker_id: workerId,
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      active_job_id: null,
      metadata: {},
    },
    { onConflict: "worker_id" },
  );

  if (error) throw error;
}

/**
 * Update the worker's heartbeat timestamp and optionally report the
 * currently active job.
 */
export async function sendHeartbeat(
  admin: AdminClient,
  workerId: string,
  activeJobId: string | null,
): Promise<void> {
  const { error } = await admin
    .from("worker_heartbeats")
    .update({
      last_heartbeat_at: new Date().toISOString(),
      active_job_id: activeJobId,
    })
    .eq("worker_id", workerId);

  if (error) {
    // Heartbeat failures are non-fatal — log and continue.
    console.error("[worker] heartbeat failed", { error: error.message, workerId });
  }
}

/**
 * Deregister this worker on graceful shutdown.
 */
export async function deregisterWorker(admin: AdminClient, workerId: string): Promise<void> {
  const { error } = await admin.from("worker_heartbeats").delete().eq("worker_id", workerId);

  if (error) {
    console.error("[worker] deregister failed", { error: error.message, workerId });
  }
}
