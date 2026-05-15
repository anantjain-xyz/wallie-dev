import type { Tables } from "@/lib/supabase/database.types";

import type { SessionPhaseStatus, SessionSummary } from "@/features/sessions/types";

// Mappers from `sessions` table rows to the domain types the UI consumes.
// The session row no longer carries phase/name/slug — those live on
// pipeline_stages — so the mapper takes them as a separate stage record so
// callers can pre-join (or pre-resolve via a stage map) without an extra
// query per row.

type SessionRow = Pick<
  Tables<"sessions">,
  | "archived_at"
  | "created_at"
  | "current_artifact_version"
  | "current_stage_id"
  | "id"
  | "linear_issue_id"
  | "linear_issue_url"
  | "number"
  | "phase_status"
  | "pipeline_id"
  | "prompt_md"
  | "rejection_count"
  | "title"
  | "updated_at"
  | "workspace_id"
>;

export interface CurrentStageInfo {
  name: string;
  slug: string;
}

export function mapSessionRow(
  row: SessionRow,
  stage: CurrentStageInfo,
  pullRequestCount = 0,
): SessionSummary {
  return {
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    currentArtifactVersion: row.current_artifact_version,
    currentStageId: row.current_stage_id,
    currentStageName: stage.name,
    currentStageSlug: stage.slug,
    id: row.id,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: row.number,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    pipelineId: row.pipeline_id,
    promptMd: row.prompt_md,
    pullRequestCount,
    rejectionCount: row.rejection_count,
    title: row.title,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}
