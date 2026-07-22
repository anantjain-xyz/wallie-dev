import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type { PipelineStage, SessionPipeline } from "@/features/sessions/types";

type AdminClient = SupabaseClient<Database>;

export function mapStageRow(row: Tables<"pipeline_stages">): PipelineStage {
  return {
    anyoneCanApprove: row.anyone_can_approve,
    approverMemberIds: row.approver_member_ids ?? [],
    description: row.description,
    id: row.id,
    name: row.name,
    pipelineId: row.pipeline_id,
    position: row.position,
    promptTemplateMd: row.prompt_template_md,
    slug: row.slug,
  };
}

export async function loadStageById(
  admin: AdminClient,
  stageId: string,
): Promise<PipelineStage | null> {
  const { data, error } = await admin
    .from("pipeline_stages")
    .select("*")
    .eq("id", stageId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapStageRow(data) : null;
}

export async function loadPipelineWithStages(
  admin: AdminClient,
  pipelineId: string,
): Promise<SessionPipeline | null> {
  const [{ data: pipelineRow, error: pipelineError }, { data: stageRows, error: stagesError }] =
    await Promise.all([
      admin.from("pipelines").select("*").eq("id", pipelineId).maybeSingle(),
      admin
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position", { ascending: true }),
    ]);

  if (pipelineError) throw pipelineError;
  if (stagesError) throw stagesError;
  if (!pipelineRow) return null;

  return {
    id: pipelineRow.id,
    isDefault: pipelineRow.is_default,
    name: pipelineRow.name,
    operatingRulesMd: pipelineRow.operating_rules_md ?? "",
    stages: (stageRows ?? []).map(mapStageRow),
  };
}

export async function loadPipelineOperatingRules(
  admin: AdminClient,
  pipelineId: string,
): Promise<string> {
  const { data, error } = await admin
    .from("pipelines")
    .select("operating_rules_md")
    .eq("id", pipelineId)
    .maybeSingle();
  if (error) throw error;
  return data?.operating_rules_md ?? "";
}

export async function loadDefaultPipelineForWorkspace(
  admin: AdminClient,
  workspaceId: string,
): Promise<SessionPipeline | null> {
  const { data, error } = await admin
    .from("pipelines")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return loadPipelineWithStages(admin, data.id);
}

export async function loadCompletedStageArtifacts(
  admin: AdminClient,
  sessionId: string,
): Promise<Record<string, string>> {
  // Map slug → latest markdown artifact for every completed stage on this
  // session. Used by the prompt renderer for {{artifact.previousStages.<slug>}}.
  const { data, error } = await admin
    .from("session_artifacts")
    .select("stage_slug, version, artifact_json")
    .eq("session_id", sessionId)
    .order("version", { ascending: true });
  if (error) throw error;

  const result: Record<string, string> = {};
  for (const row of data ?? []) {
    const value = row.artifact_json;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    // Later versions win — natural with the ascending sort above.
    result[row.stage_slug] = text;
  }
  return result;
}
