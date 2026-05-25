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
import { asLooseSupabaseClient } from "@/lib/supabase/loose";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

type LinearRoutingRow = {
  land_stage_slug: string;
  rework_stage_slug: string;
  status_mappings: unknown;
};

export async function loadLinearRoutingConfig(
  admin: AdminClient,
  workspaceId: string,
): Promise<LinearRoutingConfig> {
  const loose = asLooseSupabaseClient(admin);
  const { data, error } = await loose
    .from("workspace_linear_routing")
    .select("status_mappings, rework_stage_slug, land_stage_slug")
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return DEFAULT_LINEAR_ROUTING_CONFIG;

  const row = data as LinearRoutingRow;
  return coerceLinearRoutingConfig({
    landStageSlug: row.land_stage_slug,
    reworkStageSlug: row.rework_stage_slug,
    statusMappings: row.status_mappings,
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
  const loose = asLooseSupabaseClient(input.admin);
  const { error } = await loose.from("workspace_linear_routing").upsert(
    {
      land_stage_slug: parsed.landStageSlug,
      rework_stage_slug: parsed.reworkStageSlug,
      status_mappings: normalizedMappings,
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
