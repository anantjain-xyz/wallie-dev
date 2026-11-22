import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import { routingCanaryAlertSchema } from "./canary-alert";

export async function loadFactoryRoutingCanaryAlert(
  client: Pick<SupabaseClient<Database>, "rpc">,
  {
    workspaceId,
    factoryId,
    canaryId,
    alertId,
  }: { workspaceId: string; factoryId: string; canaryId: string; alertId?: string },
) {
  const { data, error } = await client.rpc("get_factory_routing_canary_alert", {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_canary_id: canaryId,
    ...(alertId ? { p_alert_id: alertId } : {}),
  });
  if (error) throw error;
  return data === null ? null : routingCanaryAlertSchema.parse(data);
}
