import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { stopSandboxById } from "@/lib/sandbox";

type AdminClient = SupabaseClient<Database>;

export interface StallSweepResult {
  stalledRunIds: string[];
  stalledJobIds: string[];
  stoppedSandboxIds: string[];
  retriedJobIds: string[];
}

/**
 * Sweep for stalled agent runs — runs in active status whose
 * last_activity_at is older than the workspace's stall_timeout_ms (or the
 * provided default). Marks them as errored, stops their orphaned sandbox,
 * and either reschedules the parent job for retry (attempts remaining) or
 * marks it terminally errored (attempts exhausted).
 */
export async function sweepStalledRuns(
  admin: AdminClient,
  defaultStallTimeoutMs: number,
): Promise<StallSweepResult> {
  const result: StallSweepResult = {
    stalledRunIds: [],
    stalledJobIds: [],
    stoppedSandboxIds: [],
    retriedJobIds: [],
  };

  // Find all active runs. Include runs with NULL last_activity_at — those
  // are pre-existing rows from before the column default was added, or edge
  // cases where the default didn't fire. We use created_at as a fallback
  // timestamp so no run can escape stall detection.
  const { data: activeRuns, error } = await admin
    .from("agent_runs")
    .select("id, workspace_id, agent_job_id, last_activity_at, created_at, status, sandbox_id")
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

  // Load per-workspace stall timeouts and retry caps in bulk.
  const workspaceIds = [...new Set(activeRuns.map((r) => r.workspace_id))];
  const stallTimeouts = await loadStallTimeouts(admin, workspaceIds);
  const maxRetries = await loadMaxRetries(admin, workspaceIds);

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

    // Stop the orphaned sandbox. Best-effort: stopSandboxById swallows its
    // own errors, so a stale or already-stopped sandbox cannot break the
    // sweep batch.
    if (run.sandbox_id) {
      await stopSandboxById(run.sandbox_id);
      result.stoppedSandboxIds.push(run.sandbox_id);
    }

    // Resolve the parent job: retry if attempts remain, otherwise mark
    // terminally errored. `schedule_job_retry` only re-queues the job row; it
    // doesn't re-enter the in-flight processor. The next worker poll picks it
    // up cleanly.
    if (run.agent_job_id) {
      await resolveStalledJob({
        admin,
        elapsedMs: elapsed,
        jobId: run.agent_job_id,
        maxRetries: maxRetries.get(run.workspace_id) ?? DEFAULT_MAX_RETRIES,
        result,
        timeoutMs,
      });

      // Transition the session out of agent_generating so the UI is not
      // stuck. Retried jobs flip back to agent_generating when claimed.
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
      sandboxId: run.sandbox_id,
      timeoutMs,
      workspaceId: run.workspace_id,
    });
  }

  return result;
}

const DEFAULT_MAX_RETRIES = 3;

/**
 * Decide whether to retry the parent job (attempts remaining) or mark it
 * terminally errored (attempts exhausted). Mirrors the retry semantics in
 * `markPipelineJobError` so a stalled job is recovered the same way as a
 * job that errored synchronously.
 */
async function resolveStalledJob(input: {
  admin: AdminClient;
  elapsedMs: number;
  jobId: string;
  maxRetries: number;
  result: StallSweepResult;
  timeoutMs: number;
}): Promise<void> {
  const { admin, elapsedMs, jobId, maxRetries, result, timeoutMs } = input;
  const lastError = `Stalled: no activity for ${Math.round(elapsedMs / 1000)}s (timeout: ${Math.round(timeoutMs / 1000)}s)`;

  // Read the current attempt count to decide retry vs terminal.
  const { data: jobRow } = await admin
    .from("agent_jobs")
    .select("attempt_count")
    .eq("id", jobId)
    .maybeSingle();

  const attemptCount = jobRow?.attempt_count ?? 0;

  if (attemptCount < maxRetries) {
    const { error: retryError } = await admin.rpc("schedule_job_retry", {
      target_job_id: jobId,
      base_delay_ms: 5000,
      max_backoff_ms: 300000,
    });

    if (!retryError) {
      // Record the stall reason on the row so operators see why it was
      // rescheduled. schedule_job_retry leaves last_error untouched.
      await admin.from("agent_jobs").update({ last_error: lastError }).eq("id", jobId);
      result.retriedJobIds.push(jobId);
      return;
    }

    console.error("[stall-detector] retry RPC failed; marking job terminal", {
      error: retryError.message,
      jobId,
    });
  }

  const { error: jobError } = await admin
    .from("agent_jobs")
    .update({
      finished_at: new Date().toISOString(),
      last_error: lastError,
      status: "error",
    })
    .eq("id", jobId)
    .eq("status", "running");

  if (!jobError) {
    result.stalledJobIds.push(jobId);
  }
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

/**
 * Load max_retries per workspace; missing entries fall back to the default.
 */
async function loadMaxRetries(
  admin: AdminClient,
  workspaceIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();

  if (workspaceIds.length === 0) return result;

  const { data, error } = await admin
    .from("workspace_agent_config")
    .select("workspace_id, value_json")
    .in("workspace_id", workspaceIds)
    .eq("key", "max_retries");

  if (error) {
    console.error("[stall-detector] failed to load max retries", { error: error.message });
    return result;
  }

  for (const row of data ?? []) {
    const value = row.value_json;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      result.set(row.workspace_id, value);
    }
  }

  return result;
}
