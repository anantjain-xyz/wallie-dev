import type { SupabaseClient } from "@supabase/supabase-js";

import { classifyLinearStatus } from "@/lib/linear-routing/contracts";
import {
  fetchLinearStateObservations,
  LinearRateLimitedError,
} from "@/lib/linear-routing/observations";
import { loadLinearRoutingSnapshot } from "@/lib/linear-routing/server";
import { cleanupSessionWorkReceipt } from "@/lib/pipeline/cancel";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";
import { resolveQueuedRunConfig } from "@/lib/wallie/service";

type AdminClient = SupabaseClient<Database>;
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

/** Observe each Linear state span once; all routing writes commit in the RPC.
 * Cleanup uses only that transaction's exact run IDs after it has committed.
 */
export async function reconcileLinearState(
  admin: AdminClient,
  options: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const result: ReconcileResult = { checked: 0, canceled: 0, rateLimited: false };
  let cursor: string | null = null;
  for (;;) {
    let query = admin
      .from("sessions")
      .select("id, workspace_id, linear_issue_id, updated_at, phase_status")
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
    if (!sessions?.length) break;
    const workspaceIds = [...new Set(sessions.map((session) => session.workspace_id))];
    const apiKeys = await loadLinearApiKeys(admin, workspaceIds);
    for (const workspaceId of workspaceIds) {
      const apiKey = apiKeys.get(workspaceId);
      if (!apiKey) continue;
      const workspaceSessions = sessions.filter((session) => session.workspace_id === workspaceId);
      try {
        const routing = await loadLinearRoutingSnapshot(admin, workspaceId);
        const issueIds = [
          ...new Set(
            workspaceSessions.flatMap((session) =>
              session.linear_issue_id ? [session.linear_issue_id] : [],
            ),
          ),
        ];
        const observations = await fetchLinearStateObservations(apiKey, issueIds, sleep);
        for (const session of workspaceSessions) {
          result.checked++;
          const observation = session.linear_issue_id
            ? observations.get(session.linear_issue_id)
            : undefined;
          if (!observation || !session.linear_issue_id) continue;
          try {
            const classification = classifyLinearStatus(observation.statusName, routing.config);
            const needsRun =
              classification.action === "rework" ||
              classification.action === "land" ||
              (classification.action === "start_or_continue" &&
                ["in_progress", "rejected"].includes(session.phase_status));
            const run = needsRun ? await resolveQueuedRunConfig(admin, session) : null;
            const { data, error: routeError } = await admin.rpc("apply_linear_session_transition", {
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
            if (routeError) throw routeError;
            const receipt = data?.[0];
            if (!receipt) throw new Error("Linear transition returned no receipt.");
            if (receipt.outcome === "archived") result.canceled++;
            await cleanupSessionWorkReceipt(admin, {
              receipt,
              workspaceId,
              reason: `Linear issue moved to "${observation.statusName}".`,
            });
          } catch (routeError) {
            console.error("[reconciler] failed to apply Linear route", {
              error: routeError instanceof Error ? routeError.message : String(routeError),
              sessionId: session.id,
            });
          }
        }
      } catch (workspaceError) {
        if (workspaceError instanceof LinearRateLimitedError) {
          result.rateLimited = true;
          return result;
        }
        console.error("[reconciler] failed to observe Linear workspace", {
          error: workspaceError instanceof Error ? workspaceError.message : String(workspaceError),
          workspaceId,
        });
      }
    }
    cursor = sessions[sessions.length - 1]!.id;
    if (sessions.length < PAGE_SIZE) break;
  }
  return result;
}

async function loadLinearApiKeys(
  admin: AdminClient,
  workspaceIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (workspaceIds.length === 0) return result;

  const { data, error } = await admin
    .from("workspace_secrets")
    .select("workspace_id, encrypted_value")
    .in("workspace_id", workspaceIds)
    .eq("key", "LINEAR_API_KEY");

  if (error) {
    console.error("[reconciler] failed to load Linear API keys", { error: error.message });
    return result;
  }

  for (const row of data ?? []) {
    try {
      result.set(row.workspace_id, decryptSecretValue(row.encrypted_value));
    } catch {
      // Decryption failed — skip this workspace.
    }
  }

  return result;
}
