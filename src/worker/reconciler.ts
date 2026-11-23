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
type IssueObservations = Map<string, LinearStateObservation | null>;

const PAGE_SIZE = 50;
const CONCURRENT_LIFECYCLE_WORKSPACES = 5;
const CONCURRENT_AUTOMATION_WORKSPACES = 5;

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
  observations: IssueObservations,
  workspaceId: string,
): Promise<Cursor | null> {
  const links = sessions.flatMap((session) =>
    session.linear_issue_id
      ? [{ sessionId: session.id, linkedIssueId: session.linear_issue_id }]
      : [],
  );
  const spans = links.flatMap(({ sessionId, linkedIssueId }) => {
    const observation = observations.get(linkedIssueId);
    return observation ? [linearSpanPayload(sessionId, linkedIssueId, observation)] : [];
  });
  const { data, error } = await admin.rpc("commit_linear_automation_span_page", {
    p_expected_generation: progress.generation,
    p_session_links: links,
    p_observations: spans,
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
  workspaceId: string,
  sessions: LinkedSession[],
  observations: IssueObservations,
  result: ReconcileResult,
) {
  const routing = await loadLinearRoutingSnapshot(admin, workspaceId);
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

function groupLinkedSessions(sessions: LinkedSession[]) {
  const groups = new Map<string, LinkedSession[]>();
  for (const session of sessions) {
    const group = groups.get(session.workspace_id);
    if (group) group.push(session);
    else groups.set(session.workspace_id, [session]);
  }
  return groups;
}

async function forEachWorkspace<T>(
  workspaces: ReadonlyMap<string, T>,
  work: (workspaceId: string, item: T) => Promise<void>,
) {
  const pending = workspaces.entries();
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENT_LIFECYCLE_WORKSPACES, workspaces.size) }, async () => {
      for (const [workspaceId, item] of pending) {
        try {
          await work(workspaceId, item);
        } catch (error) {
          console.error("[reconciler] failed to reconcile Linear workspace", {
            error: error instanceof Error ? error.message : String(error),
            workspaceId,
          });
        }
      }
    }),
  );
}

async function observeWorkspace(
  workspaceId: string,
  sessions: LinkedSession[],
  apiKey: string | undefined,
  throttled: Set<string>,
  sleep: (ms: number) => Promise<void>,
  observed: IssueObservations = new Map(),
): Promise<IssueObservations | null> {
  if (!apiKey) return new Map();
  const issueIds = [...new Set(sessions.flatMap((session) => session.linear_issue_id ?? []))];
  const missing = issueIds.filter((id) => !observed.has(id));
  try {
    const fetched = missing.length
      ? await fetchLinearStateObservations(apiKey, missing, sleep)
      : new Map<string, LinearStateObservation>();
    return new Map(issueIds.map((id) => [id, observed.get(id) ?? fetched.get(id) ?? null]));
  } catch (error) {
    if (error instanceof LinearRateLimitedError) {
      throttled.add(workspaceId);
    } else {
      console.error("[reconciler] failed to observe Linear workspace", {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
    }
    return null;
  }
}

async function advanceWorkspaceAutomation(
  admin: AdminClient,
  workspaceId: string,
  progress: Cursor,
  apiKey: string | undefined,
  throttled: Set<string>,
  sleep: (ms: number) => Promise<void>,
  observed?: IssueObservations,
): Promise<Cursor | null> {
  const sessions = await loadLinkedSessionPage(admin, progress.after_session_id, workspaceId);
  if (!sessions || (!sessions.length && !progress.after_session_id)) return null;
  const observations = await observeWorkspace(
    workspaceId,
    sessions,
    apiKey,
    throttled,
    sleep,
    observed,
  );
  if (!observations || throttled.has(workspaceId)) return null;
  const next = await commitAutomationPage(admin, progress, sessions, observations, workspaceId);
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
  const throttled = new Set<string>();
  const scheduledAutomation = new Set<string>();
  const queuedAutomation = new Map<string, Cursor | null>();
  const activeAutomation = new Set<Promise<void>>();

  function startAutomation(
    scope: string,
    savedProgress: Cursor | null,
    recent?: { apiKey: string | undefined; observations: IssueObservations | null },
  ) {
    const task = (async () => {
      if (throttled.has(scope)) return;
      const progress = savedProgress ?? (await readAutomationCursor(admin, scope));
      if (!progress) return;
      const apiKeys = recent ? undefined : await loadLinearApiKeys(admin, [scope]);
      const apiKey = recent ? recent.apiKey : apiKeys?.get(scope);
      if (apiKeys === null || apiKey === null || throttled.has(scope)) return;
      const next = await advanceWorkspaceAutomation(
        admin,
        scope,
        progress,
        apiKey,
        throttled,
        sleep,
        recent?.observations ?? undefined,
      );
      if (next) queuedAutomation.set(scope, next);
    })()
      .catch((error) => {
        console.error("[reconciler] failed to advance Linear automation workspace", {
          error: error instanceof Error ? error.message : String(error),
          workspaceId: scope,
        });
      })
      .finally(() => {
        activeAutomation.delete(task);
        const next = queuedAutomation.entries().next();
        if (!next.done) {
          const [scope, progress] = next.value;
          queuedAutomation.delete(scope);
          startAutomation(scope, progress);
        }
      });
    activeAutomation.add(task);
  }

  function scheduleAutomation(
    scope: string,
    recent?: { apiKey: string | undefined; observations: IssueObservations | null },
  ) {
    if (scheduledAutomation.has(scope) || throttled.has(scope)) return;
    scheduledAutomation.add(scope);
    if (activeAutomation.size < CONCURRENT_AUTOMATION_WORKSPACES) {
      startAutomation(scope, null, recent);
    } else {
      queuedAutomation.set(scope, null);
    }
  }

  try {
    let lifecycleAfter: string | null = null;
    for (;;) {
      const sessions = await loadLinkedSessionPage(admin, lifecycleAfter, workspaceId);
      if (!sessions?.length) break;
      const workspaces = groupLinkedSessions(sessions);
      const apiKeys = await loadLinearApiKeys(admin, [...workspaces.keys()]);
      if (apiKeys) {
        await forEachWorkspace(workspaces, async (scope, linked) => {
          const apiKey = apiKeys.get(scope);
          if (apiKey === null || throttled.has(scope)) return;
          const fresh = await observeWorkspace(scope, linked, apiKey, throttled, sleep);
          if (fresh?.size) {
            try {
              await routeLinkedSessions(admin, scope, linked, fresh, result);
            } catch (error) {
              console.error("[reconciler] failed to route Linear workspace", {
                error: error instanceof Error ? error.message : String(error),
                workspaceId: scope,
              });
            }
          }
          scheduleAutomation(scope, { apiKey, observations: fresh });
        });
      }
      if (sessions.length < PAGE_SIZE) break;
      lifecycleAfter = sessions.at(-1)!.id;
    }

    // A scoped sweep can reset an exhausted cursor after its final link was archived.
    if (workspaceId) scheduleAutomation(workspaceId);
  } finally {
    // Automation retries do not occupy a lifecycle slot. Drain before returning
    // so the worker owns every persistence operation started by this sweep.
    while (activeAutomation.size) await Promise.race(activeAutomation);
  }

  result.rateLimited = throttled.size > 0;
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
