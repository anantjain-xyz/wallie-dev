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
import type { Database, Json } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export async function loadLinearRoutingConfig(
  admin: AdminClient,
  workspaceId: string,
): Promise<LinearRoutingConfig> {
  const { data, error } = await admin
    .from("workspace_linear_routing")
    .select("status_mappings, rework_stage_slug, land_stage_slug")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return DEFAULT_LINEAR_ROUTING_CONFIG;

  return coerceLinearRoutingConfig({
    landStageSlug: data.land_stage_slug,
    reworkStageSlug: data.rework_stage_slug,
    statusMappings: data.status_mappings,
  });
}

export async function validateLinearRoutingStages(input: {
  admin: AdminClient;
  config: LinearRoutingUpdateInput;
  workspaceId: string;
}): Promise<{ error?: string; ok: boolean }> {
  const requiredSlugs = [input.config.reworkStageSlug, input.config.landStageSlug].filter(
    (slug): slug is string => Boolean(slug),
  );

  const uniqueSlugs = [...new Set(requiredSlugs)];
  const { data, error } = await input.admin
    .from("pipelines")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("is_default", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return { error: "Workspace has no default pipeline.", ok: false };
  }

  const { data: stages, error: stageError } = await input.admin
    .from("pipeline_stages")
    .select("slug")
    .eq("pipeline_id", data.id)
    .is("archived_at", null)
    .in("slug", uniqueSlugs);

  if (stageError) throw stageError;

  const found = new Set((stages ?? []).map((stage) => stage.slug));
  const missing = uniqueSlugs.filter((slug) => !found.has(slug));
  if (missing.length > 0) {
    return {
      error: `Unknown pipeline stage slug${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      ok: false,
    };
  }

  return { ok: true };
}

export async function upsertLinearRoutingConfig(input: {
  admin: AdminClient;
  config: LinearRoutingUpdateInput;
  workspaceId: string;
}): Promise<LinearRoutingConfig> {
  const parsed = linearRoutingUpdateSchema.parse(input.config);
  const normalizedMappings = normalizeStatusMappings(parsed.statusMappings);
  const { error } = await input.admin.from("workspace_linear_routing").upsert(
    {
      land_stage_slug: parsed.landStageSlug,
      rework_stage_slug: parsed.reworkStageSlug,
      status_mappings: normalizedMappings as Json,
      workspace_id: input.workspaceId,
    },
    { onConflict: "workspace_id" },
  );

  if (error) throw error;

  return {
    landStageSlug: parsed.landStageSlug,
    reworkStageSlug: parsed.reworkStageSlug,
    statusMappings: normalizedMappings,
  };
}
