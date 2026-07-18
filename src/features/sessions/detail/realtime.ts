import type { Tables } from "@/lib/supabase/database.types";
import type { SessionReviewSession } from "@/features/sessions/detail/data";
import type {
  SessionArtifactSummary,
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
  | "prompt_md"
  | "title"
  | "updated_at"
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
  session: SessionReviewSession,
  row: SessionRealtimeRow,
): SessionReviewSession {
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
    currentStageSlug: currentStage?.slug ?? session.currentStageSlug,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: row.number,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    promptMd: row.prompt_md,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

export function mergeArtifactRealtimeRow(
  session: SessionReviewSession,
  row: ArtifactRealtimeRow,
): SessionReviewSession {
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
  session: SessionReviewSession,
  row: CompletionRealtimeRow,
): SessionReviewSession {
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
