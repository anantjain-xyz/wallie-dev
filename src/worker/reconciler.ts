import type { SupabaseClient } from "@supabase/supabase-js";

import { classifyLinearStatus } from "@/lib/linear-routing/contracts";
import {
  fetchLinearStateObservations,
  LinearRateLimitedError,
  type LinearStateObservation,
} from "@/lib/linear-routing/observations";
import { loadLinearRoutingSnapshot } from "@/lib/linear-routing/server";
import { cleanupSessionWorkReceipt } from "@/lib/pipeline/cancel";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { resolveQueuedRunConfig } from "@/lib/wallie/service";

type AdminClient = SupabaseClient<Database>;
type LinkedSession = Pick<
  Tables<"sessions">,
  | "id"
  | "workspace_id"
  | "linear_issue_id"
  | "updated_at"
  | "phase_status"
  | "execution_exhausted_at"
>;
type Cursor = { after_session_id: string | null; generation: number };
type WorkspaceObservations = {
  workspaceId: string;
  sessions: LinkedSession[];
  observations: Map<string, LinearStateObservation>;
  cachedIssueIds: Set<string>;
};

const PAGE_SIZE = 50;
type ProviderPage = {
  workspaces: WorkspaceObservations[];
  failedWorkspaces: Set<string>;
};
type ProviderReads = {
  observations: Map<string, LinearStateObservation | null>;
  throttledWorkspaces: Set<string>;
  unreadableWorkspaces: Set<string>;
};
export interface ReconcileResult {
  checked: number;
  canceled: number;
  rateLimited: boolean;
}
export interface ReconcileOptions {
  sleep?: (ms: number) => Promise<void>;
  workspaceId?: string;
}

async function readAutomationCursor(
  admin: AdminClient,
  workspaceId: string,
): Promise<Cursor | null> {
  const { data, error } = await admin.rpc("read_linear_automation_span_cursor", {
    p_workspace_id: workspaceId,
  });
  if (error || !data?.[0]) {
    console.error("[reconciler] failed to read Linear automation cursor", {
      error: error?.message,
    });
    return null;
  }
  return data[0];
}

function linearSpanPayload(
  sessionId: string,
  linkedIssueId: string,
  observation: LinearStateObservation,
) {
  return {
    sessionId,
    linkedIssueId,
    issueId: observation.issueId,
    spanId: observation.spanId,
    startedAt: observation.startedAt,
    issueUpdatedAt: observation.issueUpdatedAt,
    stateId: observation.stateId,
    teamId: observation.teamId,
    projectId: observation.projectId,
  };
}

async function commitAutomationPage(
  admin: AdminClient,
  progress: Cursor,
  sessions: LinkedSession[],
  page: WorkspaceObservations[],
  workspaceId: string,
): Promise<Cursor | null> {
  const observations = page.flatMap((workspace) =>
    workspace.sessions.flatMap((session) => {
      const linkedIssueId = session.linear_issue_id;
      const observation = linkedIssueId ? workspace.observations.get(linkedIssueId) : undefined;
      return linkedIssueId && observation
        ? [linearSpanPayload(session.id, linkedIssueId, observation)]
        : [];
    }),
  );
  const { data, error } = await admin.rpc("commit_linear_automation_span_page", {
    p_expected_generation: progress.generation,
    p_session_ids: sessions.map((session) => session.id),
    p_observations: observations,
    p_workspace_id: workspaceId,
  });
  if (error || !data?.[0]) {
    if (error?.code !== "PT409") {
      console.error("[reconciler] failed to commit Linear automation page", {
        error: error?.message,
      });
    }
    return null;
  }
  return data[0];
}

function canArchiveLinearSession(route: ReturnType<typeof classifyLinearStatus>["route"]) {
  return route === "canceled" || route === "done";
}

async function routeLinkedSessions(
  admin: AdminClient,
  workspace: WorkspaceObservations,
  reads: ProviderReads,
  sleep: (ms: number) => Promise<void>,
  result: ReconcileResult,
) {
  const { workspaceId, sessions, observations, cachedIssueIds } = workspace;
  const routing = await loadLinearRoutingSnapshot(admin, workspaceId);
  // A cached terminal state may have been reopened before lifecycle reaches it.
  const terminalIssueIds = new Set(
    [...cachedIssueIds].filter((issueId) => {
      const observation = observations.get(issueId);
      return (
        observation &&
        canArchiveLinearSession(classifyLinearStatus(observation.statusName, routing.config).route)
      );
    }),
  );
  if (terminalIssueIds.size) {
    for (const issueId of terminalIssueIds) {
      observations.delete(issueId);
      reads.observations.delete(`${workspaceId}:${issueId}`);
    }
    const refreshed = await observeLinkedSessionPage(
      admin,
      sessions.filter(
        (session) => session.linear_issue_id && terminalIssueIds.has(session.linear_issue_id),
      ),
      reads,
      sleep,
    );
    for (const [issueId, observation] of refreshed.workspaces[0]?.observations ?? []) {
      observations.set(issueId, observation);
    }
  }
  for (const session of sessions) {
    result.checked++;
    const observation = session.linear_issue_id
      ? observations.get(session.linear_issue_id)
      : undefined;
    if (!observation || !session.linear_issue_id) continue;
    try {
      const classification = classifyLinearStatus(observation.statusName, routing.config);
      const repairRequired =
        classification.action === "rework" ||
        (classification.action === "start_or_continue" &&
          ["in_progress", "rejected"].includes(session.phase_status));
      // Exhausted repair work is already terminal. Other state changes still reconcile.
      if (session.execution_exhausted_at && repairRequired) continue;
      const needsRun = repairRequired || classification.action === "land";
      const run = needsRun ? await resolveQueuedRunConfig(admin, session) : null;
      const route = {
        p_workspace_id: workspaceId,
        p_expected_session_updated_at: session.updated_at,
        p_expected_routing_updated_at: routing.updatedAt,
        p_status_name: observation.statusName,
        p_agent_model_provider: run?.modelProvider,
        p_agent_model_name: run?.modelName,
        p_run_type: run?.runType,
      };
      // A Done route can also archive when its configured stage does not resolve.
      const { data, error } = canArchiveLinearSession(classification.route)
        ? await admin.rpc("apply_terminal_linear_session_transition", {
            ...route,
            p_observation: linearSpanPayload(session.id, session.linear_issue_id, observation),
          })
        : await admin.rpc("apply_linear_session_transition", {
            ...route,
            p_session_id: session.id,
            p_linear_issue_id: session.linear_issue_id,
            p_source_span_id: observation.spanId,
            p_source_started_at: observation.startedAt,
            p_source_state_id: observation.stateId,
            p_source_issue_updated_at: observation.issueUpdatedAt,
          });
      if (error) throw error;
      const receipt = data?.[0];
      if (!receipt) throw new Error("Linear transition returned no receipt.");
      if (receipt.outcome === "stale") continue;
      if (receipt.outcome === "archived") result.canceled++;
      await cleanupSessionWorkReceipt(admin, {
        receipt,
        workspaceId,
        reason: `Linear issue moved to "${observation.statusName}".`,
      });
    } catch (error) {
      console.error("[reconciler] failed to apply Linear route", {
        error: error instanceof Error ? error.message : String(error),
        sessionId: session.id,
      });
    }
  }
}

async function loadLinkedSessionPage(
  admin: AdminClient,
  after: string | null,
  workspaceId?: string,
) {
  let query = admin
    .from("sessions")
    .select("id, workspace_id, linear_issue_id, updated_at, phase_status, execution_exhausted_at")
    .not("linear_issue_id", "is", null)
    .is("archived_at", null)
    .in("phase_status", ["in_progress", "awaiting_review", "approved", "rejected"])
    .order("id", { ascending: true })
    .limit(PAGE_SIZE);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  if (after) query = query.gt("id", after);
  const { data, error } = await query;
  if (error) {
    console.error("[reconciler] failed to fetch sessions", { error: error.message });
    return null;
  }
  return data ?? [];
}

async function observeLinkedSessionPage(
  admin: AdminClient,
  sessions: LinkedSession[],
  reads: ProviderReads,
  sleep: (ms: number) => Promise<void>,
): Promise<ProviderPage> {
  const cache = reads.observations;
  const groups = new Map<string, LinkedSession[]>();
  const missingWorkspaces = new Set<string>();
  for (const session of sessions) {
    if (!session.linear_issue_id) continue;
    const group = groups.get(session.workspace_id);
    if (group) group.push(session);
    else groups.set(session.workspace_id, [session]);
    if (
      !reads.throttledWorkspaces.has(session.workspace_id) &&
      !reads.unreadableWorkspaces.has(session.workspace_id) &&
      !cache.has(`${session.workspace_id}:${session.linear_issue_id}`)
    ) {
      missingWorkspaces.add(session.workspace_id);
    }
  }
  const apiKeys = missingWorkspaces.size
    ? await loadLinearApiKeys(admin, [...missingWorkspaces])
    : new Map<string, string | null>();
  const page: ProviderPage = { workspaces: [], failedWorkspaces: new Set() };
  for (const [workspaceId, workspaceSessions] of groups) {
    if (reads.throttledWorkspaces.has(workspaceId) || reads.unreadableWorkspaces.has(workspaceId)) {
      page.failedWorkspaces.add(workspaceId);
      continue;
    }
    const issueIds = [
      ...new Set(workspaceSessions.flatMap((session) => session.linear_issue_id ?? [])),
    ];
    const missing = issueIds.filter((issueId) => !cache.has(`${workspaceId}:${issueId}`));
    const apiKey = apiKeys?.get(workspaceId);
    if (missing.length && (apiKeys === null || apiKey === null)) {
      if (apiKey === null) reads.unreadableWorkspaces.add(workspaceId);
      page.failedWorkspaces.add(workspaceId);
      continue;
    }
    if (missing.length && apiKey === undefined) continue;
    try {
      const fetched =
        apiKey && missing.length
          ? await fetchLinearStateObservations(apiKey, missing, sleep)
          : new Map<string, LinearStateObservation>();
      const observations = new Map<string, LinearStateObservation>();
      const cachedIssueIds = new Set<string>();
      for (const issueId of issueIds) {
        const key = `${workspaceId}:${issueId}`;
        if (cache.has(key)) cachedIssueIds.add(issueId);
        const observation = cache.get(key) ?? fetched.get(issueId) ?? null;
        cache.delete(key);
        cache.set(key, observation);
        if (observation) observations.set(issueId, observation);
      }
      page.workspaces.push({
        workspaceId,
        sessions: workspaceSessions,
        observations,
        cachedIssueIds,
      });
    } catch (error) {
      page.failedWorkspaces.add(workspaceId);
      if (error instanceof LinearRateLimitedError) {
        reads.throttledWorkspaces.add(workspaceId);
      } else {
        console.error("[reconciler] failed to observe Linear workspace", {
          error: error instanceof Error ? error.message : String(error),
          workspaceId,
        });
      }
    }
  }
  // Offset lifecycle and automation pages share a bounded provider cache.
  while (cache.size > 2 * PAGE_SIZE) cache.delete(cache.keys().next().value!);
  return page;
}

async function advanceWorkspaceAutomation(
  admin: AdminClient,
  workspaceId: string,
  knownProgress: Cursor | undefined,
  reads: ProviderReads,
  sleep: (ms: number) => Promise<void>,
): Promise<Cursor | null> {
  if (reads.throttledWorkspaces.has(workspaceId)) return null;
  const progress = knownProgress ?? (await readAutomationCursor(admin, workspaceId));
  if (!progress) return null;
  const sessions = await loadLinkedSessionPage(admin, progress.after_session_id, workspaceId);
  if (!sessions || (!sessions.length && !progress.after_session_id)) return null;
  const page = await observeLinkedSessionPage(admin, sessions, reads, sleep);
  if (page.failedWorkspaces.has(workspaceId)) return null;
  const next = await commitAutomationPage(admin, progress, sessions, page.workspaces, workspaceId);
  return next?.after_session_id ? next : null;
}

/** Sweep lifecycle links from the beginning and resume automation per workspace. */
export async function reconcileLinearState(
  admin: AdminClient,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const { workspaceId } = options;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const result: ReconcileResult = { checked: 0, canceled: 0, rateLimited: false };
  const reads: ProviderReads = {
    observations: new Map(),
    throttledWorkspaces: new Set(),
    unreadableWorkspaces: new Set(),
  };
  const cursors = new Map<string, Cursor | null>();

  let lifecycleAfter: string | null = null;
  for (;;) {
    const sessions = await loadLinkedSessionPage(admin, lifecycleAfter, workspaceId);
    if (!sessions?.length) break;
    const page = await observeLinkedSessionPage(admin, sessions, reads, sleep);
    for (const scope of new Set(sessions.map((session) => session.workspace_id))) {
      const progress = cursors.get(scope);
      if (progress === null) continue;
      cursors.set(scope, await advanceWorkspaceAutomation(admin, scope, progress, reads, sleep));
    }
    for (const workspace of page.workspaces) {
      try {
        await routeLinkedSessions(admin, workspace, reads, sleep, result);
      } catch (error) {
        console.error("[reconciler] failed to route Linear workspace", {
          error: error instanceof Error ? error.message : String(error),
          workspaceId: workspace.workspaceId,
        });
      }
    }
    if (sessions.length < PAGE_SIZE) break;
    lifecycleAfter = sessions.at(-1)!.id;
  }

  // A scoped maintenance sweep can reset an exhausted cursor after its final
  // link was archived. The normal sweep discovers workspace IDs from live links.
  if (workspaceId && !cursors.has(workspaceId)) {
    cursors.set(
      workspaceId,
      await advanceWorkspaceAutomation(admin, workspaceId, undefined, reads, sleep),
    );
  }
  for (const [scope, savedProgress] of cursors) {
    let progress = savedProgress;
    while (progress) {
      progress = await advanceWorkspaceAutomation(admin, scope, progress, reads, sleep);
    }
  }

  result.rateLimited = reads.throttledWorkspaces.size > 0;
  return result;
}

async function loadLinearApiKeys(
  admin: AdminClient,
  workspaceIds: string[],
): Promise<Map<string, string | null> | null> {
  const result = new Map<string, string | null>();
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("workspace_id, encrypted_value")
    .in("workspace_id", workspaceIds)
    .eq("key", "LINEAR_API_KEY");

  if (error) {
    console.error("[reconciler] failed to load Linear API keys", { error: error.message });
    return null;
  }

  for (const row of data ?? []) {
    try {
      result.set(row.workspace_id, decryptSecretValue(row.encrypted_value));
    } catch {
      result.set(row.workspace_id, null);
      console.error("[reconciler] failed to decrypt Linear API key", {
        workspaceId: row.workspace_id,
      });
    }
  }
  return result;
}
