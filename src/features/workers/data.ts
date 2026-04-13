import "server-only";

import { notFound } from "next/navigation";

import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type WorkerSummary = {
  activeJobId: string | null;
  lastHeartbeatAt: string;
  metadata: Record<string, unknown>;
  startedAt: string;
  status: "active" | "stale";
  workerId: string;
};

export type QueueStats = {
  errorCount: number;
  queuedCount: number;
  runningCount: number;
  successCount: number;
  totalCount: number;
};

export type WorkerHealthPageData = {
  canManage: boolean;
  queue: QueueStats;
  recentErrors: Array<{
    createdAt: string;
    id: string;
    lastError: string | null;
    sessionId: string | null;
    sessionTitle: string | null;
  }>;
  workers: WorkerSummary[];
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
};

const STALE_THRESHOLD_MS = 120_000; // 2 minutes without heartbeat = stale

export async function loadWorkerHealthPageData(
  workspaceSlug: string,
): Promise<WorkerHealthPageData> {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    notFound();
  }

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name, slug")
    .eq("slug", workspaceSlug)
    .maybeSingle();

  if (workspaceError) throw workspaceError;
  if (!workspace) notFound();

  const { data: currentMember } = await supabase
    .from("workspace_members")
    .select("id, role, is_active")
    .eq("workspace_id", workspace.id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!currentMember || !currentMember.is_active) notFound();

  const canManage = currentMember.role === "owner" || currentMember.role === "admin";

  // Load all workers (worker_heartbeats uses service_role for writes but
  // has a select policy for authenticated users).
  const { data: heartbeatRows } = await supabase
    .from("worker_heartbeats")
    .select("worker_id, started_at, last_heartbeat_at, active_job_id, metadata")
    .order("last_heartbeat_at", { ascending: false });

  const now = Date.now();
  const workers: WorkerSummary[] = (heartbeatRows ?? []).map((row) => {
    const lastBeat = new Date(row.last_heartbeat_at).getTime();
    const isStale = now - lastBeat > STALE_THRESHOLD_MS;

    return {
      activeJobId: row.active_job_id,
      lastHeartbeatAt: row.last_heartbeat_at,
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      startedAt: row.started_at,
      status: isStale ? "stale" : "active",
      workerId: row.worker_id,
    };
  });

  // Load queue stats: count agent_jobs by status for this workspace.
  // We do separate count queries since Supabase doesn't support
  // aggregate GROUP BY via the JS client cleanly.
  const [
    { count: queuedCount },
    { count: runningCount },
    { count: successCount },
    { count: errorCount },
    { count: totalCount },
  ] = await Promise.all([
    supabase
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .eq("status", "queued"),
    supabase
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .eq("status", "running"),
    supabase
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .eq("status", "success"),
    supabase
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .eq("status", "error"),
    supabase
      .from("agent_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id),
  ]);

  const queue: QueueStats = {
    errorCount: errorCount ?? 0,
    queuedCount: queuedCount ?? 0,
    runningCount: runningCount ?? 0,
    successCount: successCount ?? 0,
    totalCount: totalCount ?? 0,
  };

  // Load recent errors for visibility.
  const { data: errorJobRows } = await supabase
    .from("agent_jobs")
    .select("id, last_error, session_id, created_at")
    .eq("workspace_id", workspace.id)
    .eq("status", "error")
    .order("created_at", { ascending: false })
    .limit(10);

  // Load session titles for error jobs.
  const sessionIds = (errorJobRows ?? [])
    .map((r) => r.session_id)
    .filter((id): id is string => Boolean(id));

  let sessionTitleIndex = new Map<string, string>();
  if (sessionIds.length > 0) {
    const { data: sessionRows } = await supabase
      .from("sessions")
      .select("id, title")
      .in("id", sessionIds);

    sessionTitleIndex = new Map((sessionRows ?? []).map((r) => [r.id, r.title]));
  }

  const recentErrors = (errorJobRows ?? []).map((row) => ({
    createdAt: row.created_at,
    id: row.id,
    lastError: row.last_error,
    sessionId: row.session_id,
    sessionTitle: row.session_id ? (sessionTitleIndex.get(row.session_id) ?? null) : null,
  }));

  return {
    canManage,
    queue,
    recentErrors,
    workers,
    workspace,
  };
}
