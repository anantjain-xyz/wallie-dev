import type { SupabaseClient } from "@supabase/supabase-js";

import { listRunningSandboxes, stopSandboxById } from "@/lib/sandbox";
import type { SandboxConnection } from "@/lib/sandbox/types";
import { STALE_SANDBOX_CAPABILITY_CHECK_MS } from "@/lib/sandbox-capabilities/constants";
import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;
type VercelConnection = Extract<SandboxConnection, { provider: "vercel" }>;
type AgentRunSandboxRow = Pick<
  Tables<"agent_runs">,
  "agent_job_id" | "sandbox_id" | "status" | "workspace_id"
>;
type CapabilityCheckSandboxRow = Pick<
  Tables<"sandbox_capability_checks">,
  "checked_at" | "sandbox_id" | "status" | "workspace_id"
>;

const activeRunStatuses = ["queued", "started", "running"] as const;
const activeJobStatuses = ["queued", "started", "running"] as const;

/**
 * Conservatively remove only recorded Wallie sandboxes owned by one workspace.
 *
 * Vercel's list API is project-scoped rather than metadata-scoped, so this
 * helper also checks for active references from every workspace sharing the
 * project. Both the compatibility and provider-neutral connection APIs use
 * this exact path, preventing credential rotation from having endpoint-specific
 * cleanup behavior.
 */
export async function stopVercelWorkspaceOwnedSandboxes(input: {
  admin: AdminClient;
  connection: VercelConnection;
  workspaceId: string;
}): Promise<void> {
  const sandboxes = await listRunningSandboxes({
    connection: input.connection,
    throwOnError: true,
  });
  const sandboxIds = sandboxes.map((sandbox) => sandbox.id);
  if (sandboxIds.length === 0) return;

  const credentials = input.connection.credentials;
  const [runResult, checkResult] = await Promise.all([
    input.admin
      .from("agent_runs")
      .select("sandbox_id, status, workspace_id, agent_job_id")
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", credentials.teamId)
      .eq("sandbox_vercel_project_id", credentials.projectId)
      .in("sandbox_id", sandboxIds),
    input.admin
      .from("sandbox_capability_checks")
      .select("sandbox_id, status, workspace_id, checked_at")
      .eq("sandbox_provider", "vercel")
      .eq("sandbox_vercel_team_id", credentials.teamId)
      .eq("sandbox_vercel_project_id", credentials.projectId)
      .in("sandbox_id", sandboxIds),
  ]);
  if (runResult.error) throw runResult.error;
  if (checkResult.error) throw checkResult.error;

  const rows = (runResult.data ?? []) as AgentRunSandboxRow[];
  const checkRows = (checkResult.data ?? []) as CapabilityCheckSandboxRow[];
  const activeJobIds = await loadActiveAgentJobIds(
    input.admin,
    rows
      .map((row) => row.agent_job_id)
      .filter((jobId): jobId is string => typeof jobId === "string" && jobId.length > 0),
  );
  const ownedByWorkspace = new Set<string>();
  for (const row of [...rows, ...checkRows]) {
    if (row.workspace_id === input.workspaceId && row.sandbox_id) {
      ownedByWorkspace.add(row.sandbox_id);
    }
  }

  const activeAnywhere = new Set<string>();
  for (const row of rows) {
    if (
      row.sandbox_id &&
      (activeRunStatuses.includes(row.status as (typeof activeRunStatuses)[number]) ||
        (row.agent_job_id ? activeJobIds.has(row.agent_job_id) : false))
    ) {
      activeAnywhere.add(row.sandbox_id);
    }
  }
  for (const row of checkRows) {
    if (row.sandbox_id && isActiveCapabilityCheck(row)) {
      activeAnywhere.add(row.sandbox_id);
    }
  }

  for (const sandbox of sandboxes) {
    if (!ownedByWorkspace.has(sandbox.id) || activeAnywhere.has(sandbox.id)) continue;
    await stopSandboxById(sandbox.id, {
      connection: input.connection,
      throwOnError: true,
    });
  }
}

function isActiveCapabilityCheck(row: CapabilityCheckSandboxRow, now = Date.now()) {
  if (row.status !== "running") return false;
  const checkedAt = Date.parse(row.checked_at);
  if (Number.isNaN(checkedAt)) return true;
  return now - checkedAt <= STALE_SANDBOX_CAPABILITY_CHECK_MS;
}

async function loadActiveAgentJobIds(admin: AdminClient, jobIds: string[]) {
  if (jobIds.length === 0) return new Set<string>();
  const { data, error } = await admin
    .from("agent_jobs")
    .select("id")
    .in("id", [...new Set(jobIds)])
    .in("status", [...activeJobStatuses]);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.id));
}
