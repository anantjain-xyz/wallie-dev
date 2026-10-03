import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentJobStatus, AgentRunStatus } from "@/lib/pipeline/types";
import type { Database } from "@/lib/supabase/database.types";
import { stopSandboxById } from "@/lib/sandbox";
import type { SandboxConnection, SandboxProvider } from "@/lib/sandbox/types";
import { loadWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";

type AdminClient = SupabaseClient<Database>;

/**
 * The single source of truth for "this job/run is still live". Every
 * active-status guard in the processor, worker, and Wallie service imports
 * these instead of spelling the list out — the sets must match the partial
 * unique index `agent_jobs_active_dedupe_key_idx` (`status in ('queued',
 * 'started', 'running')`), and an inline copy that drifts (as one did to
 * `["queued", "running"]`) silently disables a dedupe or cancel guard.
 */
export const ACTIVE_AGENT_JOB_STATUSES = [
  "queued",
  "started",
  "running",
] as const satisfies readonly AgentJobStatus[];
export const ACTIVE_AGENT_RUN_STATUSES = [
  "queued",
  "started",
  "running",
] as const satisfies readonly AgentRunStatus[];

export type ActiveAgentJobStatus = (typeof ACTIVE_AGENT_JOB_STATUSES)[number];
export type ActiveAgentRunStatus = (typeof ACTIVE_AGENT_RUN_STATUSES)[number];

export function isActiveAgentJobStatus(status: AgentJobStatus): status is ActiveAgentJobStatus {
  return (ACTIVE_AGENT_JOB_STATUSES as readonly AgentJobStatus[]).includes(status);
}

export function isActiveAgentRunStatus(status: AgentRunStatus): status is ActiveAgentRunStatus {
  return (ACTIVE_AGENT_RUN_STATUSES as readonly AgentRunStatus[]).includes(status);
}

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

export type SessionWorkReceipt =
  Database["public"]["Functions"]["cancel_session_job_attempts"]["Returns"][number];

export type CancelSessionWorkResult = {
  canceledJobIds: string[];
  // Cleanup IDs can include a published run whose job was still active.
  canceledRunIds: string[];
  stoppedSandboxIds: string[];
};

/** Cancel and park atomically, then stop only the sandboxes in the DB receipt. */
export async function cancelSessionWork(
  admin: AdminClient,
  input: {
    expectedRunId?: string;
    parkPhaseStatus?: boolean;
    reason: string;
    sessionId: string;
    workspaceId: string;
  },
): Promise<CancelSessionWorkResult> {
  const { data, error } = await admin.rpc("cancel_session_job_attempts", {
    ...(input.expectedRunId ? { p_expected_run_id: input.expectedRunId } : {}),
    p_park_phase_status: input.parkPhaseStatus ?? true,
    p_reason: input.reason,
    p_session_id: input.sessionId,
    p_workspace_id: input.workspaceId,
  });
  if (error) throw error;

  return cleanupSessionWorkReceipt(admin, {
    receipt: data?.[0] ?? { job_ids: [], run_ids: [] },
    reason: input.reason,
    workspaceId: input.workspaceId,
  });
}

/**
 * The transaction's run IDs are the cleanup authority, including a successful
 * publisher whose job was canceled before sandbox shutdown. Never rescan the
 * session after a provider await: a replacement attempt may already be live.
 * A sandbox that attaches after cancellation is stopped by the processor's
 * guarded attach path.
 */
export async function cleanupSessionWorkReceipt(
  admin: AdminClient,
  input: { receipt: SessionWorkReceipt; reason?: string; workspaceId: string },
  connectionCache: Map<string, SandboxConnection | null> = new Map(),
): Promise<CancelSessionWorkResult> {
  const result: CancelSessionWorkResult = {
    canceledJobIds: input.receipt.job_ids,
    canceledRunIds: input.receipt.run_ids,
    stoppedSandboxIds: [],
  };
  if (input.receipt.run_ids.length === 0) return result;

  const { data: runs, error } = await admin
    .from("agent_runs")
    .select(
      "id, status, workspace_id, sandbox_id, sandbox_provider, sandbox_connection_revision, sandbox_vercel_team_id, sandbox_vercel_project_id",
    )
    .eq("workspace_id", input.workspaceId)
    .in("id", input.receipt.run_ids);
  if (error) throw error;

  for (const run of runs ?? []) {
    if (run.sandbox_id) {
      try {
        await stopRunSandbox(admin, run, connectionCache);
        result.stoppedSandboxIds.push(run.sandbox_id);
      } catch (error) {
        console.error("[cancel] failed to stop sandbox from cleanup receipt", {
          error: error instanceof Error ? error.message : String(error),
          runId: run.id,
          sandboxId: run.sandbox_id,
        });
      }
    }

    // Published runs remain successful even when their remaining job work is
    // canceled. Do not label the artifact's successful execution as canceled.
    if (input.reason && run.status === "canceled") {
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
  }
  return result;
}

export type CancelWorkspaceWorkResult = CancelSessionWorkResult;

/**
 * Cancel each session before workspace deletion or provider teardown. Commit
 * every available receipt before waiting on providers, and park generations in
 * the same transaction so a failed deletion needs no delayed phase rewrite.
 * Cleanup is best-effort because the owner has already confirmed deletion.
 */
export async function cancelWorkspaceWork(
  admin: AdminClient,
  input: { reason: string; workspaceId: string },
): Promise<CancelWorkspaceWorkResult> {
  const result: CancelWorkspaceWorkResult = {
    canceledJobIds: [],
    canceledRunIds: [],
    stoppedSandboxIds: [],
  };
  const receipts: SessionWorkReceipt[] = [];
  const pageSize = 500;
  let afterId: string | null = null;
  while (true) {
    let query = admin
      .from("sessions")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .order("id")
      .limit(pageSize);
    if (afterId) query = query.gt("id", afterId);
    const { data: sessions, error } = await query;
    if (error) {
      console.error("[cancel] failed to load workspace sessions", {
        error: error.message,
        workspaceId: input.workspaceId,
      });
      break;
    }

    for (const session of sessions ?? []) {
      const { data, error: cancelError } = await admin.rpc("cancel_session_job_attempts", {
        p_park_phase_status: true,
        p_reason: input.reason,
        p_session_id: session.id,
        p_workspace_id: input.workspaceId,
      });
      if (cancelError) {
        console.error("[cancel] failed to cancel workspace session", {
          error: cancelError.message,
          sessionId: session.id,
          workspaceId: input.workspaceId,
        });
        continue;
      }
      const receipt = data?.[0] ?? { job_ids: [], run_ids: [] };
      receipts.push(receipt);
      result.canceledJobIds.push(...receipt.job_ids);
      result.canceledRunIds.push(...receipt.run_ids);
    }
    if (!sessions || sessions.length < pageSize) break;
    afterId = sessions[sessions.length - 1]!.id;
  }

  const connectionCache = new Map<string, SandboxConnection | null>();
  for (const receipt of receipts) {
    try {
      const cleanup = await cleanupSessionWorkReceipt(
        admin,
        { receipt, workspaceId: input.workspaceId },
        connectionCache,
      );
      result.stoppedSandboxIds.push(...cleanup.stoppedSandboxIds);
    } catch (error) {
      console.error("[cancel] failed to clean up canceled workspace runs", {
        error: error instanceof Error ? error.message : String(error),
        workspaceId: input.workspaceId,
      });
    }
  }
  return result;
}
