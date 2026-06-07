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
      active_job_ids: [],
      metadata: {},
    },
    { onConflict: "worker_id" },
  );

  if (error) throw error;
}

/**
 * Update the worker's heartbeat timestamp and report the jobs it is currently
 * processing. The worker runs multiple jobs concurrently, so this is the full
 * in-flight set — the stall detector uses it to skip runs a live worker holds.
 */
export async function sendHeartbeat(
  admin: AdminClient,
  workerId: string,
  activeJobIds: string[],
): Promise<void> {
  const { error } = await admin
    .from("worker_heartbeats")
    .update({
      last_heartbeat_at: new Date().toISOString(),
      active_job_ids: activeJobIds,
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
