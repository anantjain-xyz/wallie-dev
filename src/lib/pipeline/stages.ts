import "server-only";

import { createHash } from "node:crypto";

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

export type AttemptPredecessor =
  | {
      status: "approved";
      stageId: string;
      stageSlug: string;
      approvalReceiptId: string;
      artifactId: string;
      artifactVersion: number;
      artifactDigest: string;
    }
  | { status: "legacy_unverified"; stageId: string | null; stageSlug: string };

type PredecessorApprovalRow =
  Database["public"]["Functions"]["load_attempt_predecessor_approvals"]["Returns"][number];

export async function loadAttemptPredecessors(
  admin: AdminClient,
  sessionId: string,
): Promise<{ promptArtifacts: Record<string, string>; predecessors: AttemptPredecessor[] }> {
  const { data, error } = await admin.rpc("load_attempt_predecessor_approvals", {
    p_session_id: sessionId,
  });
  if (error) throw error;

  // Reroutes can leave more than one historical completion label for the same
  // stable stage. The receipt query orders verified approvals first.
  const seenStages = new Set<string>();
  const completions = (data ?? []).filter((row) => {
    if (!row.stage_id) return true;
    if (seenStages.has(row.stage_id)) return false;
    seenStages.add(row.stage_id);
    return true;
  });
  const legacy = await loadLegacyCompletedStageText(admin, sessionId, completions);
  const promptArtifacts = new Map<string, string>();
  const predecessors = completions.map((row): AttemptPredecessor => {
    const stageSlug = row.current_stage_slug ?? row.stage_slug;
    if (!row.approval_receipt_id) {
      const text = row.stage_id ? legacy.get(row.stage_id) : undefined;
      if (row.current_stage_slug && text !== undefined) promptArtifacts.set(stageSlug, text);
      return { status: "legacy_unverified", stageId: row.stage_id ?? null, stageSlug };
    }

    const text = row.artifact_text;
    if (
      typeof text !== "string" ||
      !row.stage_id ||
      !row.artifact_id ||
      !row.artifact_version ||
      createHash("sha256").update(text, "utf8").digest("hex") !== row.artifact_digest
    ) {
      throw new Error(
        `The approved artifact for stage "${stageSlug}" is unavailable or does not match its approval receipt.`,
      );
    }
    if (row.current_stage_slug) promptArtifacts.set(stageSlug, text);
    return {
      status: "approved",
      stageId: row.stage_id,
      stageSlug,
      approvalReceiptId: row.approval_receipt_id,
      artifactId: row.artifact_id,
      artifactVersion: row.artifact_version,
      artifactDigest: row.artifact_digest,
    };
  });

  return { promptArtifacts: Object.fromEntries(promptArtifacts), predecessors };
}

async function loadLegacyCompletedStageText(
  admin: AdminClient,
  sessionId: string,
  completions: PredecessorApprovalRow[],
): Promise<Map<string, string>> {
  // Keep the legacy renderer's input available without treating the highest
  // retained version as evidence of which artifact a reviewer approved.
  const legacySlugs = new Map(
    completions.flatMap((completion) =>
      !completion.approval_receipt_id && completion.stage_id && completion.current_stage_slug
        ? [[completion.stage_id, completion.current_stage_slug]]
        : [],
    ),
  );
  if (legacySlugs.size === 0) return new Map();
  const { data: artifacts, error } = await admin
    .from("session_artifacts")
    .select("stage_id, version, artifact_json")
    .eq("session_id", sessionId)
    .in("stage_id", [...legacySlugs.keys()]);
  if (error) throw error;

  const latestByStage = new Map<
    string,
    { artifact: NonNullable<typeof artifacts>[number]; count: number }
  >();
  for (const row of artifacts ?? []) {
    if (!row.stage_id || !legacySlugs.has(row.stage_id)) continue;
    const latest = latestByStage.get(row.stage_id);
    if (!latest || row.version > latest.artifact.version) {
      latestByStage.set(row.stage_id, { artifact: row, count: 1 });
    } else if (row.version === latest.artifact.version) {
      latest.count++;
    }
  }

  const result = new Map<string, string>();
  for (const [stageId, { artifact, count }] of latestByStage) {
    if (count > 1) {
      throw new Error(
        `Completed stage "${legacySlugs.get(stageId)}" has multiple artifacts at version ${artifact.version}. Reconcile or regenerate its history before continuing.`,
      );
    }
    const value = artifact.artifact_json;
    result.set(stageId, typeof value === "string" ? value : JSON.stringify(value));
  }
  return result;
}
