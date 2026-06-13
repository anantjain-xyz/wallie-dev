import type { Tables } from "@/lib/supabase/database.types";
import type {
  SessionArtifactSummary,
  SessionDetail,
  SessionPhaseCompletion,
  SessionPhaseStatus,
} from "@/features/sessions/types";

type SessionRealtimeRow = Pick<
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

type ArtifactRealtimeRow = Pick<
  Tables<"session_artifacts">,
  "artifact_json" | "created_at" | "session_id" | "stage_slug" | "version"
>;

type CompletionRealtimeRow = Pick<
  Tables<"session_phase_completions">,
  "completed_at" | "session_id" | "stage_slug"
>;

export function mergeSessionRealtimeRow(
  session: SessionDetail,
  row: SessionRealtimeRow,
): SessionDetail {
  if (row.id !== session.id) {
    return session;
  }

  const currentStage = session.pipeline.stages.find((stage) => stage.id === row.current_stage_id);

  return {
    ...session,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    currentArtifactVersion: row.current_artifact_version,
    currentStageId: row.current_stage_id,
    currentStageName: currentStage?.name ?? session.currentStageName,
    currentStagePosition: currentStage?.position ?? session.currentStagePosition,
    currentStageSlug: currentStage?.slug ?? session.currentStageSlug,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: row.number,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    pipelineId: row.pipeline_id,
    promptMd: row.prompt_md,
    rejectionCount: row.rejection_count,
    title: row.title,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

export function mergeArtifactRealtimeRow(
  session: SessionDetail,
  row: ArtifactRealtimeRow,
): SessionDetail {
  if (row.session_id !== session.id) {
    return session;
  }

  const artifact: SessionArtifactSummary = {
    createdAt: row.created_at,
    payload: row.artifact_json,
    stageSlug: row.stage_slug,
    version: row.version,
  };
  const artifacts = session.artifacts.filter(
    (current) => current.stageSlug !== artifact.stageSlug || current.version !== artifact.version,
  );

  artifacts.push(artifact);

  return {
    ...session,
    artifacts,
  };
}

export function mergeCompletionRealtimeRow(
  session: SessionDetail,
  row: CompletionRealtimeRow,
): SessionDetail {
  if (row.session_id !== session.id) {
    return session;
  }

  const completion: SessionPhaseCompletion = {
    completedAt: row.completed_at,
    stageSlug: row.stage_slug,
  };
  const phaseCompletions = session.phaseCompletions.filter(
    (current) => current.stageSlug !== completion.stageSlug,
  );

  phaseCompletions.push(completion);

  return {
    ...session,
    phaseCompletions,
  };
}
