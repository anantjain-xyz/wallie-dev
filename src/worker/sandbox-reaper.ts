import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { listRunningSandboxes, stopSandboxById } from "@/lib/sandbox";
import { STALE_SANDBOX_CAPABILITY_CHECK_MS } from "@/lib/sandbox-capabilities/constants";
import { loadConnectedVercelSandboxConnections } from "@/lib/vercel-sandbox/server";

type AdminClient = SupabaseClient<Database>;
type AgentRunSandboxRow = Pick<Tables<"agent_runs">, "agent_job_id" | "sandbox_id" | "status">;
type CapabilityCheckSandboxRow = Pick<
  Tables<"sandbox_capability_checks">,
  "checked_at" | "sandbox_id" | "status"
>;

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
    // Vercel project, and which still have active runs/checks/jobs? Unknown
    // IDs may belong to other consumers in the customer's project, so leave
    // them alone.
    const candidateIds = candidates.map((s) => s.id);
    const projectState = await loadKnownProjectSandboxState({
      admin,
      candidateIds,
      projectId: connection.credentials.projectId,
      teamId: connection.credentials.teamId,
    });

    if (!projectState) {
      continue;
    }

    const orphans = candidates.filter(
      (s) => projectState.known.has(s.id) && !projectState.active.has(s.id),
    );

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

async function loadKnownProjectSandboxState(input: {
  admin: AdminClient;
  candidateIds: string[];
  projectId: string;
  teamId: string;
}): Promise<{ active: Set<string>; known: Set<string> } | null> {
  const [runResult, checkResult] = await Promise.all([
    input.admin
      .from("agent_runs")
      .select("sandbox_id, status, agent_job_id")
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", input.teamId)
      .eq("sandbox_vercel_project_id", input.projectId)
      .in("sandbox_id", input.candidateIds),
    input.admin
      .from("sandbox_capability_checks")
      .select("sandbox_id, status, checked_at")
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", input.teamId)
      .eq("sandbox_vercel_project_id", input.projectId)
      .in("sandbox_id", input.candidateIds),
  ]);

  if (runResult.error) {
    console.error("[sandbox-reaper] failed to load known runs", {
      error: runResult.error.message,
    });
    return null;
  }
  if (checkResult.error) {
    console.error("[sandbox-reaper] failed to load known capability checks", {
      error: checkResult.error.message,
    });
    return null;
  }

  const runRows = (runResult.data ?? []) as AgentRunSandboxRow[];
  const checkRows = (checkResult.data ?? []) as CapabilityCheckSandboxRow[];
  const known = new Set<string>();
  const active = new Set<string>();

  for (const row of runRows) {
    if (!row.sandbox_id) continue;
    known.add(row.sandbox_id);
    if (isActiveRunStatus(row.status)) {
      active.add(row.sandbox_id);
    }
  }

  for (const row of checkRows) {
    if (!row.sandbox_id) continue;
    known.add(row.sandbox_id);
    if (isActiveCapabilityCheck(row)) {
      active.add(row.sandbox_id);
    }
  }

  const activeJobIds = await loadActiveAgentJobIds(
    input.admin,
    runRows
      .map((row) => row.agent_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );

  if (!activeJobIds) {
    return null;
  }

  for (const row of runRows) {
    if (row.sandbox_id && row.agent_job_id && activeJobIds.has(row.agent_job_id)) {
      active.add(row.sandbox_id);
    }
  }

  return { active, known };
}

async function loadActiveAgentJobIds(
  admin: AdminClient,
  jobIds: string[],
): Promise<Set<string> | null> {
  if (jobIds.length === 0) {
    return new Set();
  }

  const { data, error } = await admin
    .from("agent_jobs")
    .select("id")
    .in("id", [...new Set(jobIds)])
    .in("status", ["queued", "started", "running"]);

  if (error) {
    console.error("[sandbox-reaper] failed to load active jobs", { error: error.message });
    return null;
  }

  return new Set((data ?? []).map((row) => row.id));
}

function isActiveRunStatus(status: Tables<"agent_runs">["status"]) {
  return status === "queued" || status === "started" || status === "running";
}

function isActiveCapabilityCheck(row: CapabilityCheckSandboxRow, now = Date.now()) {
  if (row.status !== "running") return false;
  const checkedAt = Date.parse(row.checked_at);
  if (Number.isNaN(checkedAt)) return true;
  return now - checkedAt <= STALE_SANDBOX_CAPABILITY_CHECK_MS;
}
