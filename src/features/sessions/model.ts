import type { Tables } from "@/lib/supabase/database.types";

import type { SessionPhase, SessionPhaseStatus, SessionSummary } from "@/features/sessions/types";

// Adapter between the current schema (pipeline_issues + issues) and the new
// session-shaped domain types. PR 2 replaces the row source with the real
// `sessions` table; this adapter either goes away or becomes a no-op mapper.

type PipelineRow = Pick<
  Tables<"pipeline_issues">,
  | "created_at"
  | "current_artifact_version"
  | "id"
  | "issue_id"
  | "linear_issue_id"
  | "linear_issue_url"
  | "phase"
  | "phase_status"
  | "rejection_count"
  | "slack_channel_id"
  | "slack_thread_ts"
  | "updated_at"
  | "workspace_id"
> & {
  issues: Pick<
    Tables<"issues">,
    "description_md" | "number" | "status" | "title"
  > | null;
};

export function mapPipelineRowToSession(
  row: PipelineRow,
  pullRequestCount = 0,
): SessionSummary {
  return {
    archivedAt: row.issues?.status === "canceled" ? row.updated_at : null,
    createdAt: row.created_at,
    currentArtifactVersion: row.current_artifact_version,
    id: row.id,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: row.issues?.number ?? 0,
    phase: row.phase as SessionPhase,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    promptMd: row.issues?.description_md ?? "",
    pullRequestCount,
    rejectionCount: row.rejection_count,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    title: row.issues?.title ?? "Untitled session",
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

// A minimally-shaped row coming back from the realtime channel (no join).
// The caller is responsible for supplying the last-known `title` and
// `number` because realtime payloads don't include the joined issue row.
export function mapPipelineRealtimeRow(
  row: Tables<"pipeline_issues">,
  fallback: { number: number; pullRequestCount: number; title: string },
): SessionSummary {
  return {
    archivedAt: null,
    createdAt: row.created_at,
    currentArtifactVersion: row.current_artifact_version,
    id: row.id,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: fallback.number,
    phase: row.phase as SessionPhase,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    promptMd: "",
    pullRequestCount: fallback.pullRequestCount,
    rejectionCount: row.rejection_count,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    title: fallback.title,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}
