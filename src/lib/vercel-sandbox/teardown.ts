import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { cancelWorkspaceWork } from "@/lib/pipeline/cancel";
import { stopSandboxById } from "@/lib/sandbox";
import { STALE_SANDBOX_CAPABILITY_CHECK_MS } from "@/lib/sandbox-capabilities/constants";
import { loadWorkspaceSandboxConnection, providerLabel } from "@/lib/sandbox-connections/server";
import type { SandboxConnection, SandboxProvider } from "@/lib/sandbox/types";
import type { Database } from "@/lib/supabase/database.types";

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
 * the workspace's provider connections in one shot. Once those rows are gone
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
 *   2. Capability checks are not part of the job/run lifecycle; stop any recent
 *      check that still holds a sandbox id, whether or not it is still `running`
 *      (a check writes its terminal status before its `finally` stops the
 *      sandbox, so a process that dies in that gap leaves a finished row with a
 *      live sandbox). They normally tear down in-process via their own `finally`;
 *      this snapshot is the safety net for one whose process died first.
 *
 * Best-effort: a provider or query failure is logged, never thrown, so a cleanup
 * hiccup can't turn a successful workspace delete into an error.
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

  const alreadyStopped = new Set(result.stoppedSandboxIds);
  for (const provider of ["vercel", "e2b", "daytona"] as const) {
    // Use the unguarded loader — a connection flagged `error` may still hold
    // usable credentials, and there is nothing to lose by attempting cleanup.
    let record: Awaited<ReturnType<typeof loadWorkspaceSandboxConnection>>;
    try {
      record = await loadWorkspaceSandboxConnection(admin, workspaceId, provider);
    } catch (error) {
      console.error("[workspace-teardown] failed to load sandbox connection", {
        error: error instanceof Error ? error.message : String(error),
        provider,
        workspaceId,
      });
      continue;
    }
    if (!record) continue;

    const checkSandboxIds = await loadActiveCapabilityCheckSandboxIds(
      admin,
      workspaceId,
      record.connection,
    );
    for (const sandboxId of checkSandboxIds) {
      if (alreadyStopped.has(sandboxId)) continue;
      await stopSandboxById(sandboxId, { connection: record.connection });
      alreadyStopped.add(sandboxId);
      result.stoppedSandboxIds.push(sandboxId);
      console.log("[workspace-teardown] stopped sandbox before workspace delete", {
        provider: providerLabel(provider),
        sandboxId,
        workspaceId,
      });
    }
  }

  return result;
}

async function loadActiveCapabilityCheckSandboxIds(
  admin: AdminClient,
  workspaceId: string,
  connection: SandboxConnection,
): Promise<string[]> {
  // Only sandboxes created by this connection revision are reachable here.
  const staleCutoff = new Date(Date.now() - STALE_SANDBOX_CAPABILITY_CHECK_MS).toISOString();

  // Match every recent check that still holds a sandbox id, NOT only `running`
  // ones. A check writes its terminal `success`/`error` status before the
  // `finally` that stops its sandbox runs, so a process that dies in that gap
  // leaves a `success`/`error` row whose sandbox is still up; filtering on
  // `running` would miss it, and once the cascade drops the row and the
  // connection the reaper can't reach it either. Stopping an already-stopped
  // sandbox is a best-effort no-op, so re-stopping a check that did finish its
  // teardown is harmless. The residual a snapshot still can't cover is a check
  // that died *before* persisting its sandbox id (no id in the DB to find) —
  // bounded by the provider's auto-expiry and the check's own in-process
  // `finally`, the same irreducible window a crashed run leaves behind.
  const { data, error } = await admin
    .from("sandbox_capability_checks")
    .select("sandbox_id")
    .eq("workspace_id", workspaceId)
    .eq("sandbox_provider", connection.provider as SandboxProvider)
    .eq("sandbox_connection_revision", connection.revision)
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
