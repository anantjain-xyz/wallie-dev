import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  stopRunSandbox,
  type ActiveAgentRunStatus,
} from "@/lib/pipeline/cancel";
import type { SandboxConnection } from "@/lib/sandbox/types";

type AdminClient = SupabaseClient<Database>;

const ACTIVE_RUN_PAGE_SIZE = 100;
const FRESH_WORKER_HEARTBEAT_MS = 60_000;

type ActiveRunRow = {
  agent_job_id: string | null;
  created_at: string;
  id: string;
  last_activity_at: string | null;
  sandbox_id: string | null;
  sandbox_connection_revision: string | null;
  sandbox_provider: string | null;
  sandbox_vercel_project_id: string | null;
  sandbox_vercel_team_id: string | null;
  status: ActiveAgentRunStatus;
  workspace_id: string;
};

export interface StallSweepResult {
  stalledRunIds: string[];
  stalledJobIds: string[];
  stoppedSandboxIds: string[];
  retriedJobIds: string[];
}

export interface StallSweepOptions {
  workspaceId?: string;
}

/**
 * Sweep for stalled agent runs — runs in active status whose
 * last_activity_at is older than the workspace's stall_timeout_ms (or the
 * provided default). Marks them as errored, stops their orphaned sandbox,
 * and either reschedules the parent job for retry (attempts remaining) or
 * marks it terminally errored (attempts exhausted).
 *
 * A second pass then closes `running` jobs whose runs are all already
 * terminal. `markRunSuccess` lands before `sandbox.stop()` in a `finally`,
 * and `markPipelineJobSuccess` is after that network call; a crash there
 * leaves the run `success`, the job `running`, and the session already
 * `awaiting_review`. That job is marked `success` so the active-session
 * dedupe key is released without regenerating a published artifact.
 * Jobs whose runs are all `error` / `canceled` (or that have no runs)
 * keep the stalled-run retry-or-terminal-error policy.
 */
export async function sweepStalledRuns(
  admin: AdminClient,
  defaultStallTimeoutMs: number,
  options: StallSweepOptions = {},
): Promise<StallSweepResult> {
  const result: StallSweepResult = {
    stalledRunIds: [],
    stalledJobIds: [],
    stoppedSandboxIds: [],
    retriedJobIds: [],
  };

  const activeRuns = await loadActiveRuns(admin, options);

  if (activeRuns.length === 0) {
    await sweepRunningJobsWithTerminalRuns(admin, options, result, defaultStallTimeoutMs);
    return result;
  }

  // Load per-workspace stall timeouts and retry caps in bulk.
  const workspaceIds = [...new Set(activeRuns.map((r) => r.workspace_id))];
  const runningJobIdsForQueuedRuns = await loadRunningJobIds(
    admin,
    activeRuns
      .filter((run) => run.status === "queued")
      .map((run) => run.agent_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );
  const stallTimeouts = await loadStallTimeouts(admin, workspaceIds);
  const maxRetries = await loadMaxRetries(admin, workspaceIds);

  const now = Date.now();
  const freshWorkerJobIds = await loadFreshWorkerJobIds(admin, now);
  const sandboxConnectionCache = new Map<string, SandboxConnection | null>();

  for (const run of activeRuns) {
    if (
      run.status === "queued" &&
      (!run.agent_job_id || !runningJobIdsForQueuedRuns.has(run.agent_job_id))
    ) {
      continue;
    }

    const timeoutMs = stallTimeouts.get(run.workspace_id) ?? defaultStallTimeoutMs;
    // Use last_activity_at if set, otherwise fall back to created_at so
    // runs that never received an activity event are still swept.
    const activityTimestamp = run.last_activity_at ?? run.created_at;
    const lastActivity = new Date(activityTimestamp).getTime();
    const elapsed = now - lastActivity;
    const stallReason = formatStallReason(elapsed, timeoutMs);

    if (elapsed < timeoutMs) {
      continue;
    }

    if (run.agent_job_id && freshWorkerJobIds.has(run.agent_job_id)) {
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
      .in("status", ACTIVE_AGENT_RUN_STATUSES);

    if (updateError) {
      console.error("[stall-detector] failed to error stalled run", {
        error: updateError.message,
        runId: run.id,
      });
      continue;
    }

    result.stalledRunIds.push(run.id);
    await insertRunErrorMessage(admin, {
      message: stallReason,
      runId: run.id,
      workspaceId: run.workspace_id,
    });

    // Stop the orphaned sandbox. Best-effort: stopRunSandbox swallows its own
    // errors, so a stale or already-stopped sandbox cannot break the sweep
    // batch.
    if (run.sandbox_id) {
      await stopRunSandbox(admin, run, sandboxConnectionCache);
      result.stoppedSandboxIds.push(run.sandbox_id);
    }

    // Resolve the parent job: retry if attempts remain, otherwise mark
    // terminally errored. `schedule_job_retry` only re-queues the job row; it
    // doesn't re-enter the in-flight processor. The next worker poll picks it
    // up cleanly.
    if (run.agent_job_id) {
      await resolveStalledJob({
        admin,
        jobId: run.agent_job_id,
        maxRetries: maxRetries.get(run.workspace_id) ?? DEFAULT_MAX_RETRIES,
        result,
        stallReason,
      });

      // Transition the session out of in_progress so the UI is not
      // stuck. Retried jobs flip back to in_progress when claimed.
      const { data: jobRow } = await admin
        .from("agent_jobs")
        .select("session_id")
        .eq("id", run.agent_job_id)
        .maybeSingle();

      if (jobRow?.session_id) {
        await parkSessionForStalledJob(admin, jobRow.session_id);
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

  await sweepRunningJobsWithTerminalRuns(admin, options, result, defaultStallTimeoutMs);
  return result;
}

const DEFAULT_MAX_RETRIES = 3;
const TERMINAL_RUNS_JOB_STALL_REASON = "Stalled: running job has no active runs";

type RunningJobRow = {
  created_at: string;
  id: string;
  session_id: string;
  started_at: string | null;
  workspace_id: string;
};

/**
 * Close running jobs that the active-run sweep cannot see: every attached
 * run is already terminal (or the job has no runs).
 *
 * A crash after `publishArtifact` looks like run `success` + job `running`
 * + session `awaiting_review`. Retrying would re-claim that session and
 * mint another artifact, so those jobs are marked `success` with the same
 * running-row CAS as a live `markPipelineJobSuccess`. Jobs whose runs are
 * all `error` / `canceled` (or that have no runs) still go through
 * `resolveStalledJob` and park an `in_progress` session.
 *
 * Jobs still listed on a fresh worker heartbeat are left alone — that is
 * the live `sandbox.stop()` window after `markRunSuccess`.
 *
 * Running jobs with no `agent_runs` row at all (Linear-routed enqueue, or
 * the gap between claim and `startAgentRun`) must also be older than the
 * workspace stall timeout. The scheduler heartbeats only after claim, so a
 * concurrent sweep can otherwise retry a live job before its run exists.
 */
async function sweepRunningJobsWithTerminalRuns(
  admin: AdminClient,
  options: StallSweepOptions,
  result: StallSweepResult,
  defaultStallTimeoutMs: number,
): Promise<void> {
  const runningJobs = await loadRunningJobs(admin, options);
  if (runningJobs.length === 0) {
    return;
  }

  const freshWorkerJobIds = await loadFreshWorkerJobIds(admin, Date.now());
  const candidates = runningJobs.filter((job) => !freshWorkerJobIds.has(job.id));
  if (candidates.length === 0) {
    return;
  }

  const jobsWithActiveRuns = await loadJobIdsWithActiveRuns(
    admin,
    candidates.map((job) => job.id),
  );
  const stalled = candidates.filter((job) => !jobsWithActiveRuns.has(job.id));
  if (stalled.length === 0) {
    return;
  }

  const jobsWithSuccessfulRuns = await loadJobIdsWithSuccessfulRuns(
    admin,
    stalled.map((job) => job.id),
  );
  if (jobsWithSuccessfulRuns === null) {
    return;
  }

  const completedWithoutAck = stalled.filter((job) => jobsWithSuccessfulRuns.has(job.id));
  const failedWithoutActiveRuns = stalled.filter((job) => !jobsWithSuccessfulRuns.has(job.id));

  for (const job of completedWithoutAck) {
    const { error } = await admin
      .from("agent_jobs")
      .update({
        finished_at: new Date().toISOString(),
        status: "success",
      })
      .eq("id", job.id)
      .eq("status", "running");
    if (error) {
      console.error("[stall-detector] failed to acknowledge successful job", {
        error: error.message,
        jobId: job.id,
      });
      continue;
    }

    console.log("[stall-detector] acknowledged running job whose run already succeeded", {
      jobId: job.id,
      workspaceId: job.workspace_id,
    });
  }

  if (failedWithoutActiveRuns.length === 0) {
    return;
  }

  const jobsWithAnyRuns = await loadJobIdsWithAnyRuns(
    admin,
    failedWithoutActiveRuns.map((job) => job.id),
  );
  if (jobsWithAnyRuns === null) {
    return;
  }

  const failedWithTerminalRuns = failedWithoutActiveRuns.filter((job) =>
    jobsWithAnyRuns.has(job.id),
  );
  const runlessJobs = failedWithoutActiveRuns.filter((job) => !jobsWithAnyRuns.has(job.id));
  const agedRunlessJobs = await selectAgedRunlessJobs(admin, runlessJobs, defaultStallTimeoutMs);
  const stalledJobs = [...failedWithTerminalRuns, ...agedRunlessJobs];
  if (stalledJobs.length === 0) {
    return;
  }

  const maxRetries = await loadMaxRetries(admin, [
    ...new Set(stalledJobs.map((job) => job.workspace_id)),
  ]);

  for (const job of stalledJobs) {
    await resolveStalledJob({
      admin,
      jobId: job.id,
      maxRetries: maxRetries.get(job.workspace_id) ?? DEFAULT_MAX_RETRIES,
      result,
      stallReason: TERMINAL_RUNS_JOB_STALL_REASON,
    });
    await parkSessionForStalledJob(admin, job.session_id);

    console.log("[stall-detector] closed running job with no active runs", {
      jobId: job.id,
      workspaceId: job.workspace_id,
    });
  }
}

async function parkSessionForStalledJob(admin: AdminClient, sessionId: string): Promise<void> {
  await admin
    .from("sessions")
    .update({ phase_status: "rejected" })
    .eq("id", sessionId)
    .eq("phase_status", "in_progress");
}

async function loadRunningJobs(
  admin: AdminClient,
  options: StallSweepOptions,
): Promise<RunningJobRow[]> {
  const jobs: RunningJobRow[] = [];

  for (let offset = 0; ; offset += ACTIVE_RUN_PAGE_SIZE) {
    const runningJobQuery = admin
      .from("agent_jobs")
      .select("id, session_id, workspace_id, started_at, created_at")
      .eq("status", "running");
    const scopedRunningJobQuery = options.workspaceId
      ? runningJobQuery.eq("workspace_id", options.workspaceId)
      : runningJobQuery;
    const { data, error } = await scopedRunningJobQuery
      .order("created_at", { ascending: true })
      .range(offset, offset + ACTIVE_RUN_PAGE_SIZE - 1);

    if (error) {
      console.error("[stall-detector] failed to fetch running jobs", { error: error.message });
      return jobs;
    }

    if (!data || data.length === 0) {
      return jobs;
    }

    jobs.push(...(data as RunningJobRow[]));

    if (data.length < ACTIVE_RUN_PAGE_SIZE) {
      return jobs;
    }
  }
}

async function loadJobIdsWithActiveRuns(
  admin: AdminClient,
  jobIds: string[],
): Promise<Set<string>> {
  if (jobIds.length === 0) {
    return new Set();
  }

  const { data, error } = await admin
    .from("agent_runs")
    .select("agent_job_id")
    .in("agent_job_id", [...new Set(jobIds)])
    .in("status", ACTIVE_AGENT_RUN_STATUSES);

  if (error) {
    console.error("[stall-detector] failed to load active runs for running jobs", {
      error: error.message,
    });
    // Fail closed: a read error must not look like "no active runs" or we
    // would retry/error live jobs that still have work in flight.
    return new Set(jobIds);
  }

  return new Set(
    (data ?? [])
      .map((row) => row.agent_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );
}

async function loadJobIdsWithSuccessfulRuns(
  admin: AdminClient,
  jobIds: string[],
): Promise<Set<string> | null> {
  if (jobIds.length === 0) {
    return new Set();
  }

  const { data, error } = await admin
    .from("agent_runs")
    .select("agent_job_id")
    .in("agent_job_id", [...new Set(jobIds)])
    .eq("status", "success");

  if (error) {
    console.error("[stall-detector] failed to load successful runs for running jobs", {
      error: error.message,
    });
    // Fail closed: a read error must not look like "no success run" or we
    // would retry a generation that already published its artifact.
    return null;
  }

  return new Set(
    (data ?? [])
      .map((row) => row.agent_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );
}

async function loadJobIdsWithAnyRuns(
  admin: AdminClient,
  jobIds: string[],
): Promise<Set<string> | null> {
  if (jobIds.length === 0) {
    return new Set();
  }

  const { data, error } = await admin
    .from("agent_runs")
    .select("agent_job_id")
    .in("agent_job_id", [...new Set(jobIds)]);

  if (error) {
    console.error("[stall-detector] failed to load runs for running jobs", {
      error: error.message,
    });
    // Fail closed: a read error must not classify a live job as runless or we
    // would retry it during the claim → startAgentRun gap.
    return null;
  }

  return new Set(
    (data ?? [])
      .map((row) => row.agent_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );
}

async function selectAgedRunlessJobs(
  admin: AdminClient,
  jobs: RunningJobRow[],
  defaultStallTimeoutMs: number,
): Promise<RunningJobRow[]> {
  if (jobs.length === 0) {
    return [];
  }

  const now = Date.now();
  const stallTimeouts = await loadStallTimeouts(admin, [
    ...new Set(jobs.map((job) => job.workspace_id)),
  ]);

  return jobs.filter((job) => {
    const timeoutMs = stallTimeouts.get(job.workspace_id) ?? defaultStallTimeoutMs;
    const startedAt = job.started_at ?? job.created_at;
    const elapsed = now - new Date(startedAt).getTime();
    return Number.isFinite(elapsed) && elapsed >= timeoutMs;
  });
}

async function loadActiveRuns(
  admin: AdminClient,
  options: StallSweepOptions,
): Promise<ActiveRunRow[]> {
  const runs: ActiveRunRow[] = [];

  for (let offset = 0; ; offset += ACTIVE_RUN_PAGE_SIZE) {
    // Find all active runs. Include runs with NULL last_activity_at — those
    // are pre-existing rows from before the column default was added, or edge
    // cases where the default didn't fire. We use created_at as a fallback
    // timestamp so no run can escape stall detection.
    const activeRunQuery = admin
      .from("agent_runs")
      .select(
        "id, workspace_id, agent_job_id, last_activity_at, created_at, status, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id",
      )
      .in("status", ACTIVE_AGENT_RUN_STATUSES);
    const scopedActiveRunQuery = options.workspaceId
      ? activeRunQuery.eq("workspace_id", options.workspaceId)
      : activeRunQuery;
    const { data, error } = await scopedActiveRunQuery
      .order("created_at", { ascending: true })
      .range(offset, offset + ACTIVE_RUN_PAGE_SIZE - 1);

    if (error) {
      console.error("[stall-detector] failed to fetch active runs", { error: error.message });
      return runs;
    }

    if (!data || data.length === 0) {
      return runs;
    }

    runs.push(...(data as ActiveRunRow[]));

    if (data.length < ACTIVE_RUN_PAGE_SIZE) {
      return runs;
    }
  }
}

function formatStallReason(elapsedMs: number, timeoutMs: number): string {
  return `Stalled: no activity for ${Math.round(elapsedMs / 1000)}s (timeout: ${Math.round(timeoutMs / 1000)}s)`;
}

async function insertRunErrorMessage(
  admin: AdminClient,
  input: { message: string; runId: string; workspaceId: string },
): Promise<void> {
  const { error } = await admin.from("agent_run_messages").insert({
    agent_run_id: input.runId,
    kind: "error" as const,
    message_md: `**Error:** ${input.message}`,
    workspace_id: input.workspaceId,
  });

  if (error) {
    console.error("[stall-detector] failed to insert stalled run error message", {
      error: error.message,
      runId: input.runId,
    });
  }
}

async function loadFreshWorkerJobIds(admin: AdminClient, nowMs: number): Promise<Set<string>> {
  const cutoff = new Date(nowMs - FRESH_WORKER_HEARTBEAT_MS).toISOString();
  const { data, error } = await admin
    .from("worker_heartbeats")
    .select("active_job_ids")
    .gte("last_heartbeat_at", cutoff);

  if (error) {
    console.error("[stall-detector] failed to load worker heartbeats", { error: error.message });
    return new Set();
  }

  return new Set(
    (data ?? [])
      .flatMap((row) => row.active_job_ids ?? [])
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );
}

async function loadRunningJobIds(admin: AdminClient, jobIds: string[]): Promise<Set<string>> {
  if (jobIds.length === 0) {
    return new Set();
  }

  const { data, error } = await admin
    .from("agent_jobs")
    .select("id")
    .in("id", [...new Set(jobIds)])
    .eq("status", "running");

  if (error) {
    console.error("[stall-detector] failed to load running jobs", { error: error.message });
    return new Set();
  }

  return new Set((data ?? []).map((row) => row.id));
}

/**
 * Decide whether to retry the parent job (attempts remaining) or mark it
 * terminally errored (attempts exhausted). Mirrors the retry semantics in
 * `markPipelineJobError` so a stalled job is recovered the same way as a
 * job that errored synchronously.
 */
async function resolveStalledJob(input: {
  admin: AdminClient;
  jobId: string;
  maxRetries: number;
  result: StallSweepResult;
  stallReason: string;
}): Promise<void> {
  const { admin, jobId, maxRetries, result, stallReason } = input;

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
      await admin.from("agent_jobs").update({ last_error: stallReason }).eq("id", jobId);
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
      last_error: stallReason,
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
