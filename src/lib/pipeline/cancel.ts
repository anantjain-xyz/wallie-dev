import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { stopSandboxById } from "@/lib/sandbox";
import type { SandboxConnection, SandboxProvider } from "@/lib/sandbox/types";
import { loadWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";

type AdminClient = SupabaseClient<Database>;

export const ACTIVE_AGENT_JOB_STATUSES = ["queued", "started", "running"] as const;
export const ACTIVE_AGENT_RUN_STATUSES = ["queued", "started", "running"] as const;

/**
 * The subset of an agent_run row needed to stop its sandbox. Both the stall
 * detector and the cancel path build this shape, so the credential resolution
 * lives here once.
 */
export type RunSandboxRef = {
  id: string;
  sandbox_id: string | null;
  sandbox_connection_revision?: string | null;
  sandbox_provider: string | null;
  sandbox_vercel_project_id: string | null;
  sandbox_vercel_team_id: string | null;
  workspace_id: string;
};

/**
 * Stop the sandbox backing a run using the workspace's current connection for
 * the recorded provider. Credential rotation is serialized with active work,
 * but cancellation must still attempt cleanup if a revision changed instead of
 * silently leaking the sandbox. Best-effort: `stopSandboxById` swallows its
 * own errors so a stale or already-stopped sandbox cannot break the caller's
 * batch. A no-op when the run never acquired a sandbox.
 *
 * Pass a shared `cache` when stopping many runs so each workspace's provider
 * connection is only loaded once.
 */
export async function stopRunSandbox(
  admin: AdminClient,
  run: RunSandboxRef,
  cache: Map<string, SandboxConnection | null> = new Map(),
): Promise<void> {
  if (!run.sandbox_id) {
    return;
  }

  if (run.sandbox_provider === "fake") {
    await stopSandboxById(run.sandbox_id);
    return;
  }

  const connection = await resolveRunSandboxConnection(admin, run, cache);
  if (!connection) return;
  await stopSandboxById(run.sandbox_id, { connection });
}

async function resolveRunSandboxConnection(
  admin: AdminClient,
  run: RunSandboxRef,
  cache: Map<string, SandboxConnection | null>,
): Promise<SandboxConnection | null> {
  if (!isSandboxProvider(run.sandbox_provider)) {
    return null;
  }

  const cacheKey = `${run.workspace_id}:${run.sandbox_provider}`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  const record = await loadWorkspaceSandboxConnection(
    admin,
    run.workspace_id,
    run.sandbox_provider,
  );
  const connection = record?.connection ?? null;

  cache.set(cacheKey, connection);
  return connection;
}

function isSandboxProvider(value: string | null): value is SandboxProvider {
  return value === "vercel" || value === "e2b" || value === "daytona";
}

export type CancelSessionWorkResult = {
  canceledJobIds: string[];
  canceledRunIds: string[];
  stoppedSandboxIds: string[];
};

/**
 * Cancel all in-flight work for a session: flip its active jobs and runs to
 * `canceled`, stop their sandboxes, and (optionally) park the session out of
 * `agent_generating` so the UI is not stuck "Drafting".
 *
 * This is the single primitive behind both the user-facing cancel endpoints and
 * the reconciler's Linear-route cancellation. Durability against an in-flight
 * worker relies on the status guards in `schedule_job_retry` and the processor's
 * terminal writes: once a job is `canceled`, a late-finishing worker can neither
 * re-queue it nor flip it back to success/error.
 *
 * Setting `parkPhaseStatus` to false leaves `phase_status` untouched — the
 * reconciler uses that because its reroute/archive paths set the phase
 * themselves immediately afterward.
 */
export async function cancelSessionWork(
  admin: AdminClient,
  input: { parkPhaseStatus?: boolean; reason: string; sessionId: string },
): Promise<CancelSessionWorkResult> {
  const parkPhaseStatus = input.parkPhaseStatus ?? true;
  const nowIso = new Date().toISOString();
  const result: CancelSessionWorkResult = {
    canceledJobIds: [],
    canceledRunIds: [],
    stoppedSandboxIds: [],
  };

  const { data: canceledJobs, error: jobsError } = await admin
    .from("agent_jobs")
    .update({
      finished_at: nowIso,
      last_error: input.reason,
      status: "canceled",
    })
    .eq("session_id", input.sessionId)
    .in("status", ACTIVE_AGENT_JOB_STATUSES)
    .select("id");

  if (jobsError) {
    throw jobsError;
  }
  result.canceledJobIds = (canceledJobs ?? []).map((job) => job.id);

  // Returning the updated rows gives us each run's sandbox ref as it stood at
  // the moment it was canceled — including a sandbox id persisted in the race
  // window just before this flip. A sandbox attached *after* the flip is caught
  // instead by the active-status guard in updateRunSandbox, which stops it.
  const { data: canceledRuns, error: runsError } = await admin
    .from("agent_runs")
    .update({
      finished_at: nowIso,
      status: "canceled",
    })
    .eq("session_id", input.sessionId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select(
      "id, workspace_id, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id",
    );

  if (runsError) {
    throw runsError;
  }
  result.canceledRunIds = (canceledRuns ?? []).map((run) => run.id);

  // Stop sandboxes and record a cancel message on each run we flipped.
  const connectionCache = new Map<string, SandboxConnection | null>();
  for (const run of canceledRuns ?? []) {
    if (run.sandbox_id) {
      try {
        await stopRunSandbox(admin, run, connectionCache);
        result.stoppedSandboxIds.push(run.sandbox_id);
      } catch (error) {
        console.error("[cancel] failed to stop sandbox for canceled run", {
          error: error instanceof Error ? error.message : String(error),
          runId: run.id,
          sandboxId: run.sandbox_id,
        });
      }
    }

    const { error: messageError } = await admin.from("agent_run_messages").insert({
      agent_run_id: run.id,
      kind: "error" as const,
      message_md: `**Canceled:** ${input.reason}`,
      workspace_id: run.workspace_id,
    });

    if (messageError) {
      console.error("[cancel] failed to insert cancel message", {
        error: messageError.message,
        runId: run.id,
      });
    }
  }

  if (parkPhaseStatus) {
    // Only move a session that is mid-generation; awaiting_review / approved /
    // already-rejected sessions are left as-is. No new job is enqueued — the
    // session simply parks in `rejected` until the user re-runs or reroutes.
    const { error: sessionError } = await admin
      .from("sessions")
      .update({ phase_status: "rejected" })
      .eq("id", input.sessionId)
      .eq("phase_status", "agent_generating");

    if (sessionError) {
      throw sessionError;
    }
  }

  return result;
}

export type CancelWorkspaceWorkResult = {
  canceledJobIds: string[];
  canceledRunIds: string[];
  stoppedSandboxIds: string[];
};

/**
 * Cancel every in-flight job and run for a workspace and stop the provider
 * sandboxes those runs own. Called right before a workspace is hard-deleted.
 *
 * The delete relies on the FK cascade, which drops `agent_jobs`, `agent_runs`,
 * AND `workspace_vercel_sandbox_connections` together. A worker still mid-flight
 * when those rows vanish would leak its sandbox: no run record for the reaper to
 * find, and no connection credentials to reach the provider even if it could.
 * Cancelling first closes that window the same way {@link cancelSessionWork}
 * does for a single session:
 *
 *   - A queued job a worker has not claimed yet is refused by the claim CAS once
 *     it is `canceled`, so no new sandbox spins up after this point.
 *   - Flipping a claimed run to `canceled` makes the processor's
 *     `updateRunSandbox` active-status guard refuse a sandbox that attaches
 *     *after* the flip — the worker then stops that orphan itself. The cancel
 *     UPDATE returns each run's sandbox ref as it stood at the flip, so a sandbox
 *     that landed in the race window *just before* it is stopped here.
 *
 * Best-effort, unlike {@link cancelSessionWork}: a query or provider failure is
 * logged, never thrown, so a cleanup hiccup can't fail a delete the owner
 * explicitly confirmed. Provider TTLs bound a missed cleanup. Unlike the
 * session path it does not write a cancel message per run — those rows are
 * about to be cascade-deleted with the run.
 */
export async function cancelWorkspaceWork(
  admin: AdminClient,
  input: { reason: string; workspaceId: string },
): Promise<CancelWorkspaceWorkResult> {
  const nowIso = new Date().toISOString();
  const result: CancelWorkspaceWorkResult = {
    canceledJobIds: [],
    canceledRunIds: [],
    stoppedSandboxIds: [],
  };

  const { data: canceledJobs, error: jobsError } = await admin
    .from("agent_jobs")
    .update({
      finished_at: nowIso,
      last_error: input.reason,
      status: "canceled",
    })
    .eq("workspace_id", input.workspaceId)
    .in("status", ACTIVE_AGENT_JOB_STATUSES)
    .select("id");

  if (jobsError) {
    console.error("[cancel] failed to cancel workspace jobs", {
      error: jobsError.message,
      workspaceId: input.workspaceId,
    });
  } else {
    result.canceledJobIds = (canceledJobs ?? []).map((job) => job.id);
  }

  // Returning the updated rows gives us each run's sandbox ref as it stood at
  // the flip — including a sandbox id persisted in the race window just before
  // it. A sandbox attached *after* the flip is caught instead by the
  // active-status guard in updateRunSandbox, which stops it.
  const { data: canceledRuns, error: runsError } = await admin
    .from("agent_runs")
    .update({
      finished_at: nowIso,
      status: "canceled",
    })
    .eq("workspace_id", input.workspaceId)
    .in("status", ACTIVE_AGENT_RUN_STATUSES)
    .select(
      "id, workspace_id, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id",
    );

  if (runsError) {
    console.error("[cancel] failed to cancel workspace runs", {
      error: runsError.message,
      workspaceId: input.workspaceId,
    });
    return result;
  }
  result.canceledRunIds = (canceledRuns ?? []).map((run) => run.id);

  const connectionCache = new Map<string, SandboxConnection | null>();
  for (const run of canceledRuns ?? []) {
    if (!run.sandbox_id) {
      continue;
    }
    try {
      await stopRunSandbox(admin, run, connectionCache);
      result.stoppedSandboxIds.push(run.sandbox_id);
    } catch (error) {
      console.error("[cancel] failed to stop sandbox for canceled workspace run", {
        error: error instanceof Error ? error.message : String(error),
        runId: run.id,
        sandboxId: run.sandbox_id,
      });
    }
  }

  return result;
}
