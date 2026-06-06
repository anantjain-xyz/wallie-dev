import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { listRunningSandboxes, stopSandboxById } from "@/lib/sandbox";
import { loadConnectedVercelSandboxConnections } from "@/lib/vercel-sandbox/server";

type AdminClient = SupabaseClient<Database>;
type AgentRunSandboxRow = Pick<Tables<"agent_runs">, "sandbox_id" | "status">;

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
 * owning `agent_runs` row has finished and stop them.
 *
 * The processor's `finally` block handles the happy path; the reaper exists
 * to recover from `process.exit()` mid-stage, when that `finally` never
 * runs. The stall sweep also tries to stop the sandbox when it errors out a
 * stuck run. With BYO Vercel projects, unknown provider sandboxes may belong
 * to other consumers, so the reaper only stops IDs Wallie previously recorded.
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

    // Cross-reference: which of these sandbox IDs are known to Wallie in this
    // Vercel project, and which still have active runs? Unknown IDs may belong
    // to other consumers in the customer's project, so leave them alone.
    const candidateIds = candidates.map((s) => s.id);
    const { data: knownRuns, error } = await admin
      .from("agent_runs")
      .select("sandbox_id, status")
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", connection.credentials.teamId)
      .eq("sandbox_vercel_project_id", connection.credentials.projectId)
      .in("sandbox_id", candidateIds);

    if (error) {
      console.error("[sandbox-reaper] failed to load known runs", { error: error.message });
      continue;
    }

    const known = new Set(
      ((knownRuns ?? []) as AgentRunSandboxRow[])
        .map((r) => r.sandbox_id)
        .filter((id): id is string => id !== null),
    );
    const active = new Set(
      ((knownRuns ?? []) as AgentRunSandboxRow[])
        .filter((r) => isActiveRunStatus(r.status))
        .map((r) => r.sandbox_id)
        .filter((id): id is string => id !== null),
    );

    const orphans = candidates.filter((s) => known.has(s.id) && !active.has(s.id));

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

function isActiveRunStatus(status: Tables<"agent_runs">["status"]) {
  return status === "queued" || status === "started" || status === "running";
}
