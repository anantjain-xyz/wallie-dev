import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export interface StallSweepResult {
  stalledRunIds: string[];
  stalledJobIds: string[];
}

/**
 * Sweep for stalled agent runs — runs in active status whose
 * last_activity_at is older than the workspace's stall_timeout_ms (or the
 * provided default). Marks them as errored and transitions their parent
 * jobs to error as well.
 */
export async function sweepStalledRuns(
  admin: AdminClient,
  defaultStallTimeoutMs: number,
): Promise<StallSweepResult> {
  const result: StallSweepResult = { stalledRunIds: [], stalledJobIds: [] };

  // Find all active runs. Include runs with NULL last_activity_at — those
  // are pre-existing rows from before the column default was added, or edge
  // cases where the default didn't fire. We use created_at as a fallback
  // timestamp so no run can escape stall detection.
  const { data: activeRuns, error } = await admin
    .from("agent_runs")
    .select("id, workspace_id, agent_job_id, last_activity_at, created_at, status")
    .in("status", ["queued", "started", "running"])
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    console.error("[stall-detector] failed to fetch active runs", { error: error.message });
    return result;
  }

  if (!activeRuns || activeRuns.length === 0) {
    return result;
  }

  // Load per-workspace stall timeouts in bulk.
  const workspaceIds = [...new Set(activeRuns.map((r) => r.workspace_id))];
  const stallTimeouts = await loadStallTimeouts(admin, workspaceIds);

  const now = Date.now();

  for (const run of activeRuns) {
    const timeoutMs = stallTimeouts.get(run.workspace_id) ?? defaultStallTimeoutMs;
    // Use last_activity_at if set, otherwise fall back to created_at so
    // runs that never received an activity event are still swept.
    const activityTimestamp = run.last_activity_at ?? run.created_at;
    const lastActivity = new Date(activityTimestamp).getTime();
    const elapsed = now - lastActivity;

    if (elapsed < timeoutMs) {
      continue;
    }

    // This run is stalled — mark it as errored.
    const { error: updateError } = await admin
      .from("agent_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "error" as const,
      })
      .eq("id", run.id)
      .in("status", ["queued", "started", "running"]);

    if (updateError) {
      console.error("[stall-detector] failed to error stalled run", {
        error: updateError.message,
        runId: run.id,
      });
      continue;
    }

    result.stalledRunIds.push(run.id);

    // Also error the parent job so it doesn't block the queue.
    if (run.agent_job_id) {
      const { error: jobError } = await admin
        .from("agent_jobs")
        .update({
          finished_at: new Date().toISOString(),
          last_error: `Stalled: no activity for ${Math.round(elapsed / 1000)}s (timeout: ${Math.round(timeoutMs / 1000)}s)`,
          status: "error",
        })
        .eq("id", run.agent_job_id)
        .eq("status", "running");

      if (!jobError) {
        result.stalledJobIds.push(run.agent_job_id);
      }
    }

    // Transition the session out of agent_generating so it's not stuck.
    // The session_id lives on the agent_job row — look it up.
    if (run.agent_job_id) {
      const { data: jobRow } = await admin
        .from("agent_jobs")
        .select("session_id")
        .eq("id", run.agent_job_id)
        .maybeSingle();

      if (jobRow?.session_id) {
        await admin
          .from("sessions")
          .update({ phase_status: "rejected" })
          .eq("id", jobRow.session_id)
          .eq("phase_status", "agent_generating");
      }
    }

    console.log("[stall-detector] killed stalled run", {
      elapsed: `${Math.round(elapsed / 1000)}s`,
      runId: run.id,
      timeoutMs,
      workspaceId: run.workspace_id,
    });
  }

  return result;
}

/**
 * Load stall_timeout_ms from workspace_agent_config for a set of workspaces.
 */
async function loadStallTimeouts(
  admin: AdminClient,
  workspaceIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  if (workspaceIds.length === 0) return result;

  const { data, error } = await admin
    .from("workspace_agent_config")
    .select("workspace_id, value_json")
    .in("workspace_id", workspaceIds)
    .eq("key", "stall_timeout_ms");

  if (error) {
    console.error("[stall-detector] failed to load stall timeouts", { error: error.message });
    return result;
  }

  for (const row of data ?? []) {
    const value = row.value_json;
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      result.set(row.workspace_id, value);
    }
  }

  return result;
}
