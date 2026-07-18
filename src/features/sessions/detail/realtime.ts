import type { Tables } from "@/lib/supabase/database.types";
import type {
  SessionArtifactSummary,
  SessionDetail,
  SessionPhaseCompletion,
  SessionPhaseStatus,
} from "@/features/sessions/types";
import {
  compareSessionTimestamps,
  reconcileSessionMutationPatch,
} from "@/features/sessions/optimistic";

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
  "artifact_json" | "created_at" | "id" | "session_id" | "stage_slug" | "version"
>;

type CompletionRealtimeRow = Pick<
  Tables<"session_phase_completions">,
  "completed_at" | "id" | "session_id" | "stage_slug"
>;

export function mergeSessionRealtimeRow(
  session: SessionDetail,
  row: SessionRealtimeRow,
): SessionDetail {
  if (row.id !== session.id) {
    return session;
  }

  const patchedSession = reconcileSessionMutationPatch(session, {
    archivedAt: row.archived_at,
    currentArtifactVersion: row.current_artifact_version,
    currentStageId: row.current_stage_id,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    rejectionCount: row.rejection_count,
    title: row.title,
    updatedAt: row.updated_at,
  });

  if (patchedSession === session) return session;

  return {
    ...patchedSession,
    createdAt: row.created_at,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: row.number,
    pipelineId: row.pipeline_id,
    promptMd: row.prompt_md,
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
    id: row.id,
    payload: row.artifact_json,
    stageSlug: row.stage_slug,
    version: row.version,
  };
  const existingArtifact = session.artifacts.find(
    (current) => current.stageSlug === artifact.stageSlug && current.version === artifact.version,
  );
  if (
    existingArtifact &&
    compareSessionTimestamps(existingArtifact.createdAt, artifact.createdAt) >= 0
  ) {
    return session;
  }
  const artifacts = session.artifacts.filter(
    (current) => current.stageSlug !== artifact.stageSlug || current.version !== artifact.version,
  );

  artifacts.push(artifact);

  return {
    ...session,
    artifacts,
  };
}

export function removeArtifactRealtimeRow(
  session: SessionDetail,
  row: Pick<Tables<"session_artifacts">, "id"> &
    Partial<Pick<Tables<"session_artifacts">, "stage_slug" | "version">>,
): SessionDetail {
  const artifacts = session.artifacts.filter((artifact) => {
    if (artifact.id) return artifact.id !== row.id;
    return artifact.stageSlug !== row.stage_slug || artifact.version !== row.version;
  });

  return artifacts.length === session.artifacts.length ? session : { ...session, artifacts };
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
    id: row.id,
    stageSlug: row.stage_slug,
  };
  const existingCompletion = session.phaseCompletions.find(
    (current) => current.stageSlug === completion.stageSlug,
  );
  if (
    existingCompletion &&
    compareSessionTimestamps(existingCompletion.completedAt, completion.completedAt) >= 0
  ) {
    return session;
  }
  const phaseCompletions = session.phaseCompletions.filter(
    (current) => current.stageSlug !== completion.stageSlug,
  );

  phaseCompletions.push(completion);

  return {
    ...session,
    phaseCompletions,
  };
}

export function removeCompletionRealtimeRow(
  session: SessionDetail,
  row: Pick<Tables<"session_phase_completions">, "id"> &
    Partial<Pick<Tables<"session_phase_completions">, "stage_slug">>,
): SessionDetail {
  const phaseCompletions = session.phaseCompletions.filter((completion) => {
    if (completion.id) return completion.id !== row.id;
    return completion.stageSlug !== row.stage_slug;
  });

  return phaseCompletions.length === session.phaseCompletions.length
    ? session
    : { ...session, phaseCompletions };
}
