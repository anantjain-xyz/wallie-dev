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
};

const PAGE_SIZE = 50;
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
  workspaceId?: string,
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

async function commitAutomationPage(
  admin: AdminClient,
  progress: Cursor,
  sessions: LinkedSession[],
  page: WorkspaceObservations[],
  workspaceId?: string,
): Promise<Cursor | null> {
  const observations = page.flatMap((workspace) =>
    workspace.sessions.flatMap((session) => {
      const linkedIssueId = session.linear_issue_id;
      const observation = linkedIssueId ? workspace.observations.get(linkedIssueId) : undefined;
      if (!linkedIssueId || !observation) return [];
      return [
        {
          sessionId: session.id,
          linkedIssueId,
          issueId: observation.issueId,
          spanId: observation.spanId,
          startedAt: observation.startedAt,
          issueUpdatedAt: observation.issueUpdatedAt,
          stateId: observation.stateId,
          teamId: observation.teamId,
          projectId: observation.projectId,
        },
      ];
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

async function routeLinkedSessions(
  admin: AdminClient,
  workspace: WorkspaceObservations,
  result: ReconcileResult,
) {
  const { workspaceId, sessions, observations } = workspace;
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
      const { data, error } = await admin.rpc("apply_linear_session_transition", {
        p_session_id: session.id,
        p_workspace_id: workspaceId,
        p_linear_issue_id: session.linear_issue_id,
        p_expected_session_updated_at: session.updated_at,
        p_expected_routing_updated_at: routing.updatedAt,
        p_source_span_id: observation.spanId,
        p_source_started_at: observation.startedAt,
        p_source_state_id: observation.stateId,
        p_source_issue_updated_at: observation.issueUpdatedAt,
        p_status_name: observation.statusName,
        p_agent_model_provider: run?.modelProvider,
        p_agent_model_name: run?.modelName,
        p_run_type: run?.runType,
      });
      if (error) throw error;
      const receipt = data?.[0];
      if (!receipt) throw new Error("Linear transition returned no receipt.");
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

/** Read linked provider issues once per page for independent automation and lifecycle consumers. */
export async function reconcileLinearState(
  admin: AdminClient,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const result: ReconcileResult = { checked: 0, canceled: 0, rateLimited: false };
  let progress = await readAutomationCursor(admin, options.workspaceId);
  let cursor = progress?.after_session_id ?? null;
  for (;;) {
    let query = admin
      .from("sessions")
      .select("id, workspace_id, linear_issue_id, updated_at, phase_status, execution_exhausted_at")
      .not("linear_issue_id", "is", null)
      .is("archived_at", null)
      .in("phase_status", ["in_progress", "awaiting_review", "approved", "rejected"])
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (options.workspaceId) query = query.eq("workspace_id", options.workspaceId);
    if (cursor) query = query.gt("id", cursor);
    const { data: sessions, error } = await query;
    if (error) {
      console.error("[reconciler] failed to fetch sessions", { error: error.message });
      break;
    }
    if (!sessions?.length) {
      if (progress?.after_session_id) {
        await commitAutomationPage(admin, progress, [], [], options.workspaceId);
      }
      break;
    }

    const workspaceIds = [...new Set(sessions.map((session) => session.workspace_id))];
    const apiKeys = await loadLinearApiKeys(admin, workspaceIds);
    const page: WorkspaceObservations[] = [];
    let pageComplete = apiKeys !== null;
    for (const workspaceId of workspaceIds) {
      const apiKey = apiKeys?.get(workspaceId);
      if (!apiKey) continue;
      const workspaceSessions = sessions.filter((session) => session.workspace_id === workspaceId);
      const issueIds = [
        ...new Set(
          workspaceSessions.flatMap((session) =>
            session.linear_issue_id ? [session.linear_issue_id] : [],
          ),
        ),
      ];
      try {
        const observations = await fetchLinearStateObservations(apiKey, issueIds, sleep);
        page.push({ workspaceId, sessions: workspaceSessions, observations });
      } catch (workspaceError) {
        pageComplete = false;
        if (workspaceError instanceof LinearRateLimitedError) {
          result.rateLimited = true;
          break;
        }
        console.error("[reconciler] failed to observe Linear workspace", {
          error: workspaceError instanceof Error ? workspaceError.message : String(workspaceError),
          workspaceId,
        });
      }
    }

    // The legacy route may archive a linked session. Acknowledge the exact
    // observation page before those independent mutations can change its membership.
    if (progress) {
      progress = pageComplete
        ? await commitAutomationPage(admin, progress, sessions, page, options.workspaceId)
        : null;
    }
    for (const workspace of page) {
      try {
        await routeLinkedSessions(admin, workspace, result);
      } catch (error) {
        console.error("[reconciler] failed to route Linear workspace", {
          error: error instanceof Error ? error.message : String(error),
          workspaceId: workspace.workspaceId,
        });
      }
    }
    if (result.rateLimited || sessions.length < PAGE_SIZE) break;
    cursor = sessions[sessions.length - 1]!.id;
  }
  return result;
}

async function loadLinearApiKeys(
  admin: AdminClient,
  workspaceIds: string[],
): Promise<Map<string, string> | null> {
  const result = new Map<string, string>();
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
      // An unusable credential cannot supply an observation.
    }
  }
  return result;
}
