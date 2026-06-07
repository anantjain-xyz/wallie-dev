import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { stopSandboxById } from "@/lib/sandbox";
import type { VercelSandboxCredentials } from "@/lib/sandbox/types";
import { loadVercelSandboxConnection } from "@/lib/vercel-sandbox/server";

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
  sandbox_provider: string | null;
  sandbox_vercel_project_id: string | null;
  sandbox_vercel_team_id: string | null;
  workspace_id: string;
};

/**
 * Stop the sandbox backing a run, resolving Vercel credentials when the run was
 * launched on the Vercel provider. Best-effort: `stopSandboxById` swallows its
 * own errors so a stale or already-stopped sandbox cannot break the caller's
 * batch. A no-op when the run never acquired a sandbox.
 *
 * Pass a shared `cache` when stopping many runs so each workspace's Vercel
 * connection is only loaded once.
 */
export async function stopRunSandbox(
  admin: AdminClient,
  run: RunSandboxRef,
  cache: Map<string, VercelSandboxCredentials | null> = new Map(),
): Promise<void> {
  if (!run.sandbox_id) {
    return;
  }

  const credentials = await resolveRunVercelCredentials(admin, run, cache);
  if (credentials) {
    await stopSandboxById(run.sandbox_id, { vercelCredentials: credentials });
  } else {
    await stopSandboxById(run.sandbox_id);
  }
}

async function resolveRunVercelCredentials(
  admin: AdminClient,
  run: RunSandboxRef,
  cache: Map<string, VercelSandboxCredentials | null>,
): Promise<VercelSandboxCredentials | null> {
  if (run.sandbox_provider !== "vercel") {
    return null;
  }

  const cacheKey = `${run.workspace_id}:${run.sandbox_vercel_team_id ?? ""}:${
    run.sandbox_vercel_project_id ?? ""
  }`;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null;
  }

  const connection = await loadVercelSandboxConnection(admin, run.workspace_id);
  const credentials =
    connection &&
    connection.credentials.teamId === run.sandbox_vercel_team_id &&
    connection.credentials.projectId === run.sandbox_vercel_project_id
      ? connection.credentials
      : null;

  cache.set(cacheKey, credentials);
  return credentials;
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
      "id, workspace_id, sandbox_id, sandbox_provider, sandbox_vercel_team_id, sandbox_vercel_project_id",
    );

  if (runsError) {
    throw runsError;
  }
  result.canceledRunIds = (canceledRuns ?? []).map((run) => run.id);

  // Stop sandboxes and record a cancel message on each run we flipped.
  const credentialsCache = new Map<string, VercelSandboxCredentials | null>();
  for (const run of canceledRuns ?? []) {
    if (run.sandbox_id) {
      try {
        await stopRunSandbox(admin, run, credentialsCache);
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
