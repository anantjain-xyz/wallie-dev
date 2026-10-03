import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import type {
  ArchivedPipelineStage,
  PipelineConfiguration,
  PipelineStage,
  SessionPipeline,
} from "@/features/sessions/types";

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

function mapArchivedStageRow(row: Tables<"pipeline_stages">): ArchivedPipelineStage {
  if (!row.archived_at) {
    throw new Error(`Pipeline stage ${row.id} is not archived.`);
  }
  return { ...mapStageRow(row), archivedAt: row.archived_at };
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
        .is("archived_at", null)
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

export async function loadPipelineConfigurationWithStages(
  admin: AdminClient,
  pipelineId: string,
): Promise<PipelineConfiguration | null> {
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

  const rows = stageRows ?? [];
  return {
    archivedStages: rows
      .filter((row) => row.archived_at !== null)
      .sort((left, right) => (right.archived_at ?? "").localeCompare(left.archived_at ?? ""))
      .map(mapArchivedStageRow),
    id: pipelineRow.id,
    isDefault: pipelineRow.is_default,
    name: pipelineRow.name,
    operatingRulesMd: pipelineRow.operating_rules_md ?? "",
    stages: rows.filter((row) => row.archived_at === null).map(mapStageRow),
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

export async function loadDefaultPipelineConfigurationForWorkspace(
  admin: AdminClient,
  workspaceId: string,
): Promise<PipelineConfiguration | null> {
  const { data, error } = await admin
    .from("pipelines")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return loadPipelineConfigurationWithStages(admin, data.id);
}

export async function loadCompletedStageArtifacts(
  admin: AdminClient,
  sessionId: string,
): Promise<Record<string, string>> {
  // Completion and artifact snapshots can retain old names after a stage is
  // renamed. Associate by durable ID, then expose only the current prompt key.
  const { data: completions, error: completionError } = await admin
    .from("session_phase_completions")
    .select("stage_id")
    .eq("session_id", sessionId);
  if (completionError) throw completionError;
  const completedStageIds = [
    ...new Set(
      (completions ?? []).flatMap((completion) =>
        completion.stage_id ? [completion.stage_id] : [],
      ),
    ),
  ];
  if (completedStageIds.length === 0) return {};
  const [{ data: artifacts, error: artifactError }, { data: stages, error: stageError }] =
    await Promise.all([
      admin
        .from("session_artifacts")
        .select("stage_id, version, artifact_json")
        .eq("session_id", sessionId)
        .in("stage_id", completedStageIds)
        .order("version", { ascending: true }),
      admin.from("pipeline_stages").select("id, slug").in("id", completedStageIds),
    ]);
  if (artifactError) throw artifactError;
  if (stageError) throw stageError;

  const currentSlugs = new Map((stages ?? []).map((stage) => [stage.id, stage.slug]));
  const latestByStage = new Map<
    string,
    { artifact: NonNullable<typeof artifacts>[number]; count: number }
  >();
  for (const row of artifacts ?? []) {
    // Orphaned historical labels cannot authorize prompt input for another stage.
    if (!row.stage_id || !currentSlugs.has(row.stage_id)) continue;
    const latest = latestByStage.get(row.stage_id);
    if (!latest || row.version > latest.artifact.version) {
      latestByStage.set(row.stage_id, { artifact: row, count: 1 });
    } else if (row.version === latest.artifact.version) {
      latest.count++;
    }
  }
  const result: Record<string, string> = {};
  for (const [stageId, { artifact, count }] of latestByStage) {
    const slug = currentSlugs.get(stageId)!;
    if (count > 1) {
      throw new Error(
        `Completed stage "${slug}" has multiple artifacts at version ${artifact.version}. Reconcile or regenerate its history before continuing.`,
      );
    }
    const value = artifact.artifact_json;
    result[slug] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}
