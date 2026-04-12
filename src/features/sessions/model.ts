import type { Tables } from "@/lib/supabase/database.types";

import type { SessionPhase, SessionPhaseStatus, SessionSummary } from "@/features/sessions/types";

// Mappers from the `sessions` table rows to the session domain types the UI
// consumes. Sessions is the source of truth for phase / phase_status /
// artifacts after the backend cutover.

type SessionRow = Pick<
  Tables<"sessions">,
  | "archived_at"
  | "created_at"
  | "current_artifact_version"
  | "id"
  | "issue_id"
  | "linear_issue_id"
  | "linear_issue_url"
  | "number"
  | "phase"
  | "phase_status"
  | "prompt_md"
  | "rejection_count"
  | "slack_channel_id"
  | "slack_thread_ts"
  | "title"
  | "updated_at"
  | "workspace_id"
>;

export function mapSessionRow(row: SessionRow, pullRequestCount = 0): SessionSummary {
  return {
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    currentArtifactVersion: row.current_artifact_version,
    id: row.id,
    linearIssueId: row.linear_issue_id,
    linearIssueUrl: row.linear_issue_url,
    number: row.number,
    phase: row.phase as SessionPhase,
    phaseStatus: row.phase_status as SessionPhaseStatus,
    promptMd: row.prompt_md,
    pullRequestCount,
    rejectionCount: row.rejection_count,
    slackChannelId: row.slack_channel_id,
    slackThreadTs: row.slack_thread_ts,
    title: row.title,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

// A minimally-shaped row coming back from the realtime channel. Realtime
// payloads are the full row but no joins — the caller supplies the last
// known pull-request count because we don't re-query github_issue_branches
// on every change notification.
export function mapSessionRealtimeRow(
  row: Tables<"sessions">,
  fallback: { pullRequestCount: number },
): SessionSummary {
  return mapSessionRow(row, fallback.pullRequestCount);
}
