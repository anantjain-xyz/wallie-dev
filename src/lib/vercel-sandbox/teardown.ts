import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { cancelWorkspaceWork } from "@/lib/pipeline/cancel";
import { stopSandboxById } from "@/lib/sandbox";
import { STALE_SANDBOX_CAPABILITY_CHECK_MS } from "@/lib/sandbox-capabilities/constants";
import type { Database } from "@/lib/supabase/database.types";
import { loadVercelSandboxConnection } from "@/lib/vercel-sandbox/server";

type AdminClient = SupabaseClient<Database>;

export interface WorkspaceSandboxTeardownResult {
  /** Active jobs we flipped to `canceled` so no new sandbox spins up. */
  canceledJobIds: string[];
  /** Active runs we flipped to `canceled`. */
  canceledRunIds: string[];
  /** Provider sandbox IDs we asked the provider to stop. */
  stoppedSandboxIds: string[];
}

/**
 * Cancel a workspace's in-flight work and stop every provider sandbox it still
 * owns, right before the workspace row is hard-deleted.
 *
 * Deleting a workspace relies on the FK cascade, which drops `agent_jobs`,
 * `agent_runs`, `sandbox_capability_checks`, AND
 * `workspace_vercel_sandbox_connections` in one shot. Once those rows are gone
 * the reaper has no record of the sandbox and no credentials to reach the
 * provider, so a sandbox still running when the processor's `finally` teardown
 * never fires is orphaned with nothing to clean it up. Call this BEFORE the
 * workspace row is deleted, while both the run records and the connection
 * credentials are still present.
 *
 * Two parts:
 *   1. {@link cancelWorkspaceWork} flips active jobs and runs to `canceled`. This
 *      is what closes the race a plain snapshot can't: a run whose sandbox id has
 *      not landed yet is flipped first, so a sandbox attaching *after* the flip
 *      is refused by `updateRunSandbox` and stopped by the worker, while one that
 *      landed in the race window *just before* the flip is returned and stopped.
 *   2. Capability checks are not part of the job/run lifecycle; stop any that
 *      currently own a sandbox. They run in-process with their own `finally`
 *      teardown, so a snapshot is enough.
 *
 * Best-effort: a provider or query failure is logged, never thrown, so a cleanup
 * hiccup can't turn a successful workspace delete into an error. Vercel
 * sandboxes auto-expire, so a missed stop is a slow leak, not a permanent one.
 */
export async function stopWorkspaceProviderSandboxes(
  admin: AdminClient,
  workspaceId: string,
): Promise<WorkspaceSandboxTeardownResult> {
  const canceled = await cancelWorkspaceWork(admin, {
    reason: "Workspace deleted.",
    workspaceId,
  });
  const result: WorkspaceSandboxTeardownResult = {
    canceledJobIds: canceled.canceledJobIds,
    canceledRunIds: canceled.canceledRunIds,
    stoppedSandboxIds: [...canceled.stoppedSandboxIds],
  };

  // Credentials live in workspace_vercel_sandbox_connections and the cascade
  // will drop them with the workspace, so read them before the delete. Use the
  // unguarded loader (not loadRequired*) — a connection flagged `error` may
  // still hold a usable token, and there's nothing to lose by trying to stop.
  let connection: Awaited<ReturnType<typeof loadVercelSandboxConnection>>;
  try {
    connection = await loadVercelSandboxConnection(admin, workspaceId);
  } catch (error) {
    console.error("[workspace-teardown] failed to load Vercel connection", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId,
    });
    return result;
  }

  if (!connection) {
    return result;
  }

  const checkSandboxIds = await loadActiveCapabilityCheckSandboxIds(admin, workspaceId, {
    projectId: connection.credentials.projectId,
    teamId: connection.credentials.teamId,
  });

  // A canceled run and a running capability check could in principle reference
  // the same sandbox id; don't ask the provider to stop it twice.
  const alreadyStopped = new Set(result.stoppedSandboxIds);
  for (const sandboxId of checkSandboxIds) {
    if (alreadyStopped.has(sandboxId)) {
      continue;
    }
    await stopSandboxById(sandboxId, { vercelCredentials: connection.credentials });
    alreadyStopped.add(sandboxId);
    result.stoppedSandboxIds.push(sandboxId);
    console.log("[workspace-teardown] stopped sandbox before workspace delete", {
      sandboxId,
      workspaceId,
    });
  }

  return result;
}

async function loadActiveCapabilityCheckSandboxIds(
  admin: AdminClient,
  workspaceId: string,
  scope: { projectId: string; teamId: string },
): Promise<string[]> {
  // Only sandboxes created under the current connection's team/project can be
  // stopped with these credentials. Checks left over from a previous connection
  // reference a different team/project and aren't reachable here — the reaper
  // covers those while their (now-stale) connection still exists.
  const staleCutoff = new Date(Date.now() - STALE_SANDBOX_CAPABILITY_CHECK_MS).toISOString();

  const { data, error } = await admin
    .from("sandbox_capability_checks")
    .select("sandbox_id")
    .eq("workspace_id", workspaceId)
    .eq("sandbox_provider", "vercel")
    .eq("sandbox_vercel_team_id", scope.teamId)
    .eq("sandbox_vercel_project_id", scope.projectId)
    .eq("status", "running")
    .gte("checked_at", staleCutoff)
    .not("sandbox_id", "is", null);

  if (error) {
    console.error("[workspace-teardown] failed to load active capability checks", {
      error: error.message,
      workspaceId,
    });
    return [];
  }

  const ids = new Set<string>();
  for (const row of data ?? []) {
    if (row.sandbox_id) ids.add(row.sandbox_id);
  }
  return [...ids];
}
