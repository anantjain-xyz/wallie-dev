import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { stopSandboxById } from "@/lib/sandbox";
import { STALE_SANDBOX_CAPABILITY_CHECK_MS } from "@/lib/sandbox-capabilities/constants";
import type { Database } from "@/lib/supabase/database.types";
import { loadVercelSandboxConnection } from "@/lib/vercel-sandbox/server";

type AdminClient = SupabaseClient<Database>;

export interface WorkspaceSandboxTeardownResult {
  /** Provider sandbox IDs we asked the provider to stop. */
  stoppedSandboxIds: string[];
}

/**
 * Stop every provider sandbox that an active run or capability check in this
 * workspace still owns.
 *
 * Deleting a workspace relies on the FK cascade, which drops `agent_runs`,
 * `sandbox_capability_checks`, AND `workspace_vercel_sandbox_connections` in
 * one shot. Once those rows are gone the reaper has no record of the sandbox
 * and no credentials to reach the provider, so a sandbox still running when the
 * processor's `finally` teardown never fires is orphaned with nothing to clean
 * it up. Call this BEFORE the workspace row is deleted, while both the run
 * records and the connection credentials are still present.
 *
 * Best-effort: a provider or query failure is logged, never thrown, so a
 * cleanup hiccup can't turn a successful workspace delete into an error. Vercel
 * sandboxes auto-expire, so a missed stop is a slow leak, not a permanent one.
 */
export async function stopWorkspaceProviderSandboxes(
  admin: AdminClient,
  workspaceId: string,
): Promise<WorkspaceSandboxTeardownResult> {
  const result: WorkspaceSandboxTeardownResult = { stoppedSandboxIds: [] };

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

  const sandboxIds = await loadActiveWorkspaceSandboxIds(admin, workspaceId, {
    projectId: connection.credentials.projectId,
    teamId: connection.credentials.teamId,
  });

  for (const sandboxId of sandboxIds) {
    await stopSandboxById(sandboxId, { vercelCredentials: connection.credentials });
    result.stoppedSandboxIds.push(sandboxId);
    console.log("[workspace-teardown] stopped sandbox before workspace delete", {
      sandboxId,
      workspaceId,
    });
  }

  return result;
}

async function loadActiveWorkspaceSandboxIds(
  admin: AdminClient,
  workspaceId: string,
  scope: { projectId: string; teamId: string },
): Promise<string[]> {
  // Only sandboxes created under the current connection's team/project can be
  // stopped with these credentials. Runs left over from a previous connection
  // reference a different team/project and aren't reachable here — the reaper
  // covers those while their (now-stale) connection still exists.
  const staleCutoff = new Date(Date.now() - STALE_SANDBOX_CAPABILITY_CHECK_MS).toISOString();

  const [runResult, checkResult] = await Promise.all([
    admin
      .from("agent_runs")
      .select("sandbox_id")
      .eq("workspace_id", workspaceId)
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", scope.teamId)
      .eq("sandbox_vercel_project_id", scope.projectId)
      .in("status", ["queued", "started", "running"])
      .not("sandbox_id", "is", null),
    admin
      .from("sandbox_capability_checks")
      .select("sandbox_id")
      .eq("workspace_id", workspaceId)
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", scope.teamId)
      .eq("sandbox_vercel_project_id", scope.projectId)
      .eq("status", "running")
      .gte("checked_at", staleCutoff)
      .not("sandbox_id", "is", null),
  ]);

  const ids = new Set<string>();

  if (runResult.error) {
    console.error("[workspace-teardown] failed to load active runs", {
      error: runResult.error.message,
      workspaceId,
    });
  } else {
    for (const row of runResult.data ?? []) {
      if (row.sandbox_id) ids.add(row.sandbox_id);
    }
  }

  if (checkResult.error) {
    console.error("[workspace-teardown] failed to load active capability checks", {
      error: checkResult.error.message,
      workspaceId,
    });
  } else {
    for (const row of checkResult.data ?? []) {
      if (row.sandbox_id) ids.add(row.sandbox_id);
    }
  }

  return [...ids];
}
