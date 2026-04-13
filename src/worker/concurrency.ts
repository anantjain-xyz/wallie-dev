import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

/**
 * Load the concurrency_limit config value for a workspace.
 * Returns null if no config is set (caller should use default).
 */
export async function loadWorkspaceConcurrencyLimit(
  admin: AdminClient,
  workspaceId: string,
): Promise<number | null> {
  const { data, error } = await admin
    .from("workspace_agent_config")
    .select("value_json")
    .eq("workspace_id", workspaceId)
    .eq("key", "concurrency_limit")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const value = data.value_json;
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return null;
}

/**
 * Count the number of currently running jobs for a workspace.
 */
export async function countRunningJobs(admin: AdminClient, workspaceId: string): Promise<number> {
  const { count, error } = await admin
    .from("agent_jobs")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "running");

  if (error) throw error;
  return count ?? 0;
}

/**
 * Check if a workspace can accept another running job, respecting its
 * configured (or default) concurrency limit.
 */
export async function canAcceptJob(
  admin: AdminClient,
  workspaceId: string,
  defaultLimit: number,
): Promise<boolean> {
  const [configuredLimit, runningCount] = await Promise.all([
    loadWorkspaceConcurrencyLimit(admin, workspaceId),
    countRunningJobs(admin, workspaceId),
  ]);

  const limit = configuredLimit ?? defaultLimit;
  return runningCount < limit;
}
