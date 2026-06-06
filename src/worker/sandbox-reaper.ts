import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { listRunningSandboxes, stopSandboxById } from "@/lib/sandbox";
import { loadConnectedVercelSandboxConnections } from "@/lib/vercel-sandbox/server";

type AdminClient = SupabaseClient<Database>;

export interface SandboxReapResult {
  /** Sandbox IDs visible in the provider that we stopped because no active run owns them. */
  reapedSandboxIds: string[];
  /** Total sandbox IDs the provider returned as active. */
  activeProviderCount: number;
}

/**
 * The reaper's grace window. A sandbox younger than this is left alone even
 * if no `agent_runs` row references it yet — there is a brief window between
 * `Sandbox.create` resolving and the processor inserting the linked
 * `agent_runs` row, and we don't want the reaper to race that gap and stop a
 * fresh sandbox.
 */
const DEFAULT_REAP_GRACE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Find Vercel sandboxes that are still active in the provider but whose
 * owning `agent_runs` row has finished (or never existed) and stop them.
 *
 * The processor's `finally` block handles the happy path; the reaper exists
 * to recover from `process.exit()` mid-stage, when that `finally` never
 * runs. The stall sweep also tries to stop the sandbox when it errors out a
 * stuck run, but the reaper covers cases where the row never made it (e.g.,
 * the worker died between `Sandbox.create` and the agent_runs insert).
 */
export async function reapOrphanSandboxes(
  admin: AdminClient,
  opts: { graceMs?: number } = {},
): Promise<SandboxReapResult> {
  const graceMs = opts.graceMs ?? DEFAULT_REAP_GRACE_MS;
  const result: SandboxReapResult = {
    activeProviderCount: 0,
    reapedSandboxIds: [],
  };

  const connections = await loadConnectedVercelSandboxConnections(admin);

  if (connections.length === 0) {
    return result;
  }

  const ageCutoff = Date.now() - graceMs;

  for (const connection of connections) {
    const providerSandboxes = await listRunningSandboxes({
      vercelCredentials: connection.credentials,
    });
    result.activeProviderCount += providerSandboxes.length;

    // Drop sandboxes inside the grace window — the processor may still be
    // mid-INSERT for the corresponding agent_runs row.
    const candidates = providerSandboxes.filter((s) => s.createdAt <= ageCutoff);

    if (candidates.length === 0) {
      continue;
    }

    // Cross-reference: which of these sandbox IDs are claimed by an active
    // agent_run in this same Vercel project? Anything else is an orphan.
    const candidateIds = candidates.map((s) => s.id);
    const { data: claimedRuns, error } = await admin
      .from("agent_runs")
      .select("sandbox_id")
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", connection.credentials.teamId)
      .eq("sandbox_vercel_project_id", connection.credentials.projectId)
      .in("sandbox_id", candidateIds)
      .in("status", ["queued", "started", "running"]);

    if (error) {
      console.error("[sandbox-reaper] failed to load claimed runs", { error: error.message });
      continue;
    }

    const claimed = new Set(
      (claimedRuns ?? []).map((r) => r.sandbox_id).filter((id): id is string => id !== null),
    );

    const orphans = candidates.filter((s) => !claimed.has(s.id));

    for (const orphan of orphans) {
      await stopSandboxById(orphan.id, { vercelCredentials: connection.credentials });
      result.reapedSandboxIds.push(orphan.id);
      console.log("[sandbox-reaper] stopped orphan sandbox", {
        ageMs: Date.now() - orphan.createdAt,
        sandboxId: orphan.id,
        workspaceId: connection.preview.workspaceId,
      });
    }
  }

  return result;
}
