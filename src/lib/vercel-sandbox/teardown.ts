import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { cancelWorkspaceWork } from "@/lib/pipeline/cancel";
import { stopSandboxById } from "@/lib/sandbox";
import { loadWorkspaceSandboxConnection, providerLabel } from "@/lib/sandbox-connections/server";
import { hasSandboxCleanupReceipt } from "@/lib/sandbox-connections/cleanup-receipts";
import type { SandboxProvider } from "@/lib/sandbox/types";
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
 * `agent_runs`, `sandbox_capability_checks`, `codex_device_auth_flows`, AND
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
 *   2. Capability checks and Codex device-auth flows are not part of the
 *      job/run lifecycle; stop every check or auth flow that still
 *      holds a sandbox id, regardless of its status or age
 *      (a check writes its terminal status before its `finally` stops the
 *      sandbox, so a process that dies in that gap leaves a finished row with a
 *      live sandbox). They normally tear down in-process via their own `finally`;
 *      this snapshot is the safety net for one whose process died first.
 *      Acquisition reservations separately retain IDs that arrive after this
 *      scan, until the workspace deletion coordinator cleans them up.
 *
 * A lookup or provider failure aborts deletion. The caller keeps ownership
 * records and credentials intact so a later request can finish cleanup.
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

  // A bare sandbox ID returned by run cancellation is not proof for another
  // provider/revision. Repeating an idempotent stop is safer than dropping an
  // independently recorded ownership obligation.
  const alreadyStopped = new Set<string>();
  for (const provider of ["vercel", "e2b", "daytona"] as const) {
    // Use the unguarded loader — a connection flagged `error` may still hold
    // usable credentials, and there is nothing to lose by attempting cleanup.
    const record = await loadWorkspaceSandboxConnection(admin, workspaceId, provider);

    const [checkSandboxIds, authSandboxIds] = await Promise.all([
      loadOwnedSandboxIds(admin, workspaceId, provider, "sandbox_capability_checks"),
      loadOwnedSandboxIds(admin, workspaceId, provider, "codex_device_auth_flows"),
    ]);
    for (const owner of [...checkSandboxIds, ...authSandboxIds]) {
      const sandboxId = owner.sandbox_id;
      if (!sandboxId) continue;
      const ownershipKey = `${provider}:${owner.sandbox_connection_revision}:${sandboxId}`;
      if (alreadyStopped.has(ownershipKey)) continue;
      if (
        await hasSandboxCleanupReceipt(admin, {
          connectionRevision: owner.sandbox_connection_revision,
          provider,
          sandboxId,
          workspaceId,
        })
      )
        continue;
      if (!record) throw new Error("Workspace sandbox cleanup credentials are unavailable.");
      if (owner.sandbox_connection_revision !== record.connection.revision)
        throw new Error("Workspace sandbox cleanup connection changed.");
      await stopSandboxById(sandboxId, { connection: record.connection, throwOnError: true });
      alreadyStopped.add(ownershipKey);
      if (!result.stoppedSandboxIds.includes(sandboxId)) result.stoppedSandboxIds.push(sandboxId);
      console.log("[workspace-teardown] stopped sandbox before workspace delete", {
        provider: providerLabel(provider),
        sandboxId,
        workspaceId,
      });
    }
  }

  return result;
}

async function loadOwnedSandboxIds(
  admin: AdminClient,
  workspaceId: string,
  provider: SandboxProvider,
  table: "sandbox_capability_checks" | "codex_device_auth_flows",
) {
  const owners: Array<{ sandbox_id: string | null; sandbox_connection_revision: string | null }> =
    [];
  let afterId: string | null = null;
  // Terminal rows still own cleanup if the process died before finally. Read
  // every page, regardless of status or age, while credentials are retained.
  while (true) {
    let query = admin
      .from(table)
      .select("id, sandbox_id, sandbox_connection_revision")
      .eq("workspace_id", workspaceId)
      .eq("sandbox_provider", provider)
      .not("sandbox_id", "is", null)
      .order("id")
      .limit(100);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      if (row.sandbox_id && !row.sandbox_id.startsWith("provisioning:")) owners.push(row);
    }
    afterId = data[data.length - 1]!.id;
    if (data.length < 100) break;
  }
  return owners;
}
