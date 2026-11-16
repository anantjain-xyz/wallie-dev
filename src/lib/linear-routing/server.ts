import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_LINEAR_ROUTING_CONFIG,
  coerceLinearRoutingConfig,
  linearRoutingUpdateSchema,
  normalizeStatusMappings,
  type LinearRoutingConfig,
  type LinearRoutingUpdateInput,
} from "@/lib/linear-routing/contracts";
import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export async function loadLinearRoutingConfig(
  admin: AdminClient,
  workspaceId: string,
): Promise<LinearRoutingConfig> {
  const { data, error } = await admin
    .from("workspace_linear_routing")
    .select("status_mappings, rework_stage_slug, land_stage_slug, rework_stage_id, land_stage_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return DEFAULT_LINEAR_ROUTING_CONFIG;

  return mapLinearRoutingConfig(data);
}

/** Reconciliation must never turn a failed/malformed config read into defaults. */
export async function loadLinearRoutingSnapshot(admin: AdminClient, workspaceId: string) {
  const { data, error } = await admin
    .from("workspace_linear_routing")
    .select("status_mappings, rework_stage_slug, land_stage_slug, updated_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Linear routing configuration is missing.");
  return {
    config: linearRoutingUpdateSchema.parse({
      landStageSlug: data.land_stage_slug,
      reworkStageSlug: data.rework_stage_slug,
      statusMappings: data.status_mappings,
    }),
    updatedAt: data.updated_at,
  };
}

function mapLinearRoutingConfig(
  row: Pick<
    Tables<"workspace_linear_routing">,
    | "land_stage_id"
    | "rework_stage_id"
    | "land_stage_slug"
    | "rework_stage_slug"
    | "status_mappings"
  >,
): LinearRoutingConfig {
  return coerceLinearRoutingConfig({
    landStageId: row.land_stage_id,
    landStageSlug: row.land_stage_slug,
    reworkStageId: row.rework_stage_id,
    reworkStageSlug: row.rework_stage_slug,
    statusMappings: row.status_mappings,
  });
}

export async function saveLinearRoutingConfig(input: {
  actorUserId: string;
  admin: AdminClient;
  config: LinearRoutingUpdateInput;
  workspaceId: string;
}): Promise<LinearRoutingConfig> {
  const parsed = linearRoutingUpdateSchema.parse(input.config);
  const { data, error } = await input.admin.rpc("save_linear_routing_config", {
    p_actor_user_id: input.actorUserId,
    p_workspace_id: input.workspaceId,
    p_land_slug: parsed.landStageSlug ?? undefined,
    p_rework_slug: parsed.reworkStageSlug,
    p_status_mappings: normalizeStatusMappings(parsed.statusMappings),
    p_check_revision: parsed.expectedFactoryRevisionId !== undefined,
    p_expected_revision_id: parsed.expectedFactoryRevisionId ?? undefined,
  });

  if (error) throw error;
  return mapLinearRoutingConfig(data);
}
