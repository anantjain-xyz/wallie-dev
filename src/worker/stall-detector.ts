import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { ACTIVE_AGENT_RUN_STATUSES, stopRunSandbox } from "@/lib/pipeline/cancel";
import type { SandboxConnection } from "@/lib/sandbox/types";

type AdminClient = SupabaseClient<Database>;
const PAGE_SIZE = 100;
const FRESH_WORKER_HEARTBEAT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 3;
const CLAIMED_AGENT_JOB_STATUSES = ["started", "running"] as const;
const RUNLESS_STALL_REASON = "Stalled: claimed job has no execution for this attempt";

type RecoveryRun = Pick<
  Tables<"agent_runs">,
  | "agent_job_id"
  | "attempt_count"
  | "created_at"
  | "id"
  | "last_activity_at"
  | "sandbox_id"
  | "sandbox_connection_revision"
  | "sandbox_provider"
  | "sandbox_vercel_project_id"
  | "sandbox_vercel_team_id"
  | "status"
  | "workspace_id"
>;
type ClaimedJob = Pick<
  Tables<"agent_jobs">,
  "attempt_count" | "created_at" | "id" | "started_at" | "workspace_id"
>;

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
 * Recover captured job attempts through the same ownership RPCs as the worker.
 * Publication is durable success; only a successful run bound to this exact
 * attempt may acknowledge it. A newer claim without a run ages from started_at,
 * even when the job retains terminal runs from older attempts.
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
  const jobs = await loadClaimedJobs(admin, options);
  if (!jobs.length) return result;
  const now = Date.now();
  const freshWorkerJobIds = await loadFreshWorkerJobIds(admin, now);
  if (!freshWorkerJobIds) return result;
  const candidates = jobs.filter((job) => !freshWorkerJobIds.has(job.id));
  if (!candidates.length) return result;

  const workspaceIds = [...new Set(candidates.map((job) => job.workspace_id))];
  const [runs, stallTimeouts, maxRetries] = await Promise.all([
    loadRuns(
      admin,
      candidates.map((job) => job.id),
    ),
    loadStallTimeouts(admin, workspaceIds),
    loadMaxRetries(admin, workspaceIds),
  ]);
  if (!runs) return result;
  const runsByJob = new Map<string, RecoveryRun[]>();
  for (const run of runs) {
    if (!run.agent_job_id) continue;
    const jobRuns = runsByJob.get(run.agent_job_id) ?? [];
    jobRuns.push(run);
    runsByJob.set(run.agent_job_id, jobRuns);
  }
  const sandboxConnectionCache = new Map<string, SandboxConnection | null>();

  for (const job of candidates) {
    const jobRuns = runsByJob.get(job.id) ?? [];
    const ownedRun = jobRuns.find((run) => run.attempt_count === job.attempt_count);
    if (ownedRun?.status === "success") {
      const { error } = await admin.rpc("complete_session_job_attempt", {
        p_job_id: job.id,
        p_attempt_count: job.attempt_count,
        p_run_id: ownedRun.id,
      });
      if (error)
        console.error("[stall-detector] failed to acknowledge published attempt", {
          error: error.message,
          jobId: job.id,
          runId: ownedRun.id,
        });
      continue;
    }
    // An owned terminal failure is already resolved transactionally. Legacy
    // terminal runs are history, not evidence about the latest queue claim.
    if (ownedRun && !isActiveRun(ownedRun)) continue;
    const timeoutMs = stallTimeouts.get(job.workspace_id) ?? defaultStallTimeoutMs;
    const activity = ownedRun
      ? (ownedRun.last_activity_at ?? ownedRun.created_at)
      : (job.started_at ?? job.created_at);
    const elapsed = now - Date.parse(activity);
    if (!Number.isFinite(elapsed) || elapsed < timeoutMs) continue;
    const reason = ownedRun
      ? `Stalled: no activity for ${Math.round(elapsed / 1000)}s (timeout: ${Math.round(timeoutMs / 1000)}s)`
      : RUNLESS_STALL_REASON;
    const { data: outcome, error } = await admin.rpc("fail_session_job_attempt", {
      p_job_id: job.id,
      p_attempt_count: job.attempt_count,
      p_run_id: ownedRun?.id,
      p_error: reason,
      p_retry: true,
      p_max_retries: maxRetries.get(job.workspace_id) ?? DEFAULT_MAX_RETRIES,
    });
    if (error) {
      console.error("[stall-detector] failed to recover captured attempt", {
        error: error.message,
        jobId: job.id,
        attemptCount: job.attempt_count,
      });
      continue;
    }
    // Publication may have won since our active-run snapshot. Its worker can
    // still be using the sandbox for PR delivery; success is not a cleanup receipt.
    if (outcome !== "queued" && outcome !== "error") continue;
    if (outcome === "queued") result.retriedJobIds.push(job.id);
    if (outcome === "error") result.stalledJobIds.push(job.id);

    // The RPC resolves ownership before any sandbox network operation. A retry
    // can start during stop(), but its distinct run/sandbox is never selected.
    const resolvedRuns = ownedRun
      ? [ownedRun]
      : jobRuns.filter((run) => run.attempt_count === null && isActiveRun(run));
    for (const run of resolvedRuns) {
      result.stalledRunIds.push(run.id);
      await insertRunErrorMessage(admin, run, reason);
      if (run.sandbox_id) {
        if (await stopRunSandbox(admin, run, sandboxConnectionCache)) {
          result.stoppedSandboxIds.push(run.sandbox_id);
        }
      }
    }
  }
  return result;
}

function isActiveRun(run: RecoveryRun) {
  return (ACTIVE_AGENT_RUN_STATUSES as readonly string[]).includes(run.status);
}

async function loadClaimedJobs(
  admin: AdminClient,
  options: StallSweepOptions,
): Promise<ClaimedJob[]> {
  const jobs: ClaimedJob[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const query = admin
      .from("agent_jobs")
      .select("id, attempt_count, workspace_id, started_at, created_at")
      .in("status", CLAIMED_AGENT_JOB_STATUSES);
    const scoped = options.workspaceId ? query.eq("workspace_id", options.workspaceId) : query;
    const { data, error } = await scoped
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      console.error("[stall-detector] failed to load claimed jobs", { error: error.message });
      return [];
    }
    jobs.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return jobs;
  }
}

async function loadRuns(admin: AdminClient, jobIds: string[]): Promise<RecoveryRun[] | null> {
  const runs: RecoveryRun[] = [];
  for (let batch = 0; batch < jobIds.length; batch += PAGE_SIZE) {
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await admin
        .from("agent_runs")
        .select(
          "id, workspace_id, agent_job_id, attempt_count, last_activity_at, created_at, status, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id",
        )
        .in("agent_job_id", jobIds.slice(batch, batch + PAGE_SIZE))
        .order("id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) {
        console.error("[stall-detector] failed to load attempt runs", { error: error.message });
        return null;
      }
      runs.push(...(data ?? []));
      if (!data || data.length < PAGE_SIZE) break;
    }
  }
  return runs;
}

async function insertRunErrorMessage(admin: AdminClient, run: RecoveryRun, reason: string) {
  const { error } = await admin.from("agent_run_messages").insert({
    agent_run_id: run.id,
    kind: "error",
    message_md: `**Error:** ${reason}`,
    workspace_id: run.workspace_id,
  });
  if (error)
    console.error("[stall-detector] failed to record recovery message", {
      error: error.message,
      runId: run.id,
    });
}

async function loadFreshWorkerJobIds(
  admin: AdminClient,
  nowMs: number,
): Promise<Set<string> | null> {
  const { data, error } = await admin
    .from("worker_heartbeats")
    .select("active_job_ids")
    .gte("last_heartbeat_at", new Date(nowMs - FRESH_WORKER_HEARTBEAT_MS).toISOString());
  if (error) {
    console.error("[stall-detector] failed to load worker heartbeats", { error: error.message });
    return null;
  }
  return new Set((data ?? []).flatMap((row) => row.active_job_ids ?? []));
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
