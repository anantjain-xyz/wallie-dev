import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RoutingCanaryAlert } from "@/lib/model-routing/canary-alert";
import { loadFactoryRoutingCanaryAlert } from "@/lib/model-routing/canary-alert-storage";
import {
  routingCanaryReportSchema,
  type RoutingCanaryReport,
} from "@/lib/model-routing/canary-report";
import type { Database } from "@/lib/supabase/database.types";

export type RoutingCanaryComparisonState =
  | { kind: "ready"; report: RoutingCanaryReport; latestAlert?: RoutingCanaryAlert }
  | { kind: "retained"; alert: RoutingCanaryAlert; frozenScorerRevision?: number }
  | { kind: "unavailable"; alertRequested?: boolean };

type Client = Pick<SupabaseClient<Database>, "rpc" | "from">;
type Scope = { workspaceId: string; factoryId: string };

async function readAlert(client: Client, scope: Scope, canaryId: string, alertId?: string) {
  const alert = await loadFactoryRoutingCanaryAlert(client, { ...scope, canaryId, alertId }).catch(
    () => null,
  );
  return alert &&
    alert.canaryId === canaryId &&
    alert.report.canary.id === canaryId &&
    (!alertId || alert.id === alertId)
    ? alert
    : null;
}

export async function loadRoutingCanaryComparison(
  client: Client,
  scope: Scope & { canaryId?: string; alertId?: string },
): Promise<RoutingCanaryComparisonState | null> {
  const { canaryId, alertId } = scope;
  if (alertId) {
    const alert = canaryId ? await readAlert(client, scope, canaryId, alertId) : null;
    if (!alert) return { kind: "unavailable", alertRequested: true };
    const scorerRevision = await Promise.resolve(
      client
        .from("factory_scorer_revisions")
        .select("revision_number")
        .eq("workspace_id", scope.workspaceId)
        .eq("factory_id", scope.factoryId)
        .eq("id", alert.evidence.scorerRevisionId)
        .maybeSingle(),
    ).catch(() => null);
    return { kind: "retained", alert, frozenScorerRevision: scorerRevision?.data?.revision_number };
  }

  const { data, error } = await client.rpc("get_factory_routing_canary_report", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    ...(canaryId ? { p_canary_id: canaryId } : {}),
  });
  if (error) return { kind: "unavailable" };
  if (data === null) return canaryId ? { kind: "unavailable" } : null;
  const report = routingCanaryReportSchema.safeParse(data);
  if (!report.success || (canaryId && report.data.canary.id !== canaryId)) {
    return { kind: "unavailable" };
  }
  const latestAlert = await readAlert(client, scope, report.data.canary.id);
  return { kind: "ready", report: report.data, ...(latestAlert ? { latestAlert } : {}) };
}
