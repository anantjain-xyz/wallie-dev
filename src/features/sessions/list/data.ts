import "server-only";

import type { WorkspaceSummary } from "@/lib/auth";
import type { Tables } from "@/lib/supabase/database.types";
import { loadSessionWorkspaceContext } from "@/features/sessions/server";
import { mapPipelineRowToSession } from "@/features/sessions/model";
import {
  SESSION_PHASE_ORDER,
  type SessionFilterKey,
  type SessionListQueryState,
  type SessionPhase,
  type SessionSummary,
} from "@/features/sessions/types";

export type SessionListPageData = {
  queryState: SessionListQueryState;
  sessions: SessionSummary[];
  totalCount: number;
  workspace: WorkspaceSummary;
};

type SearchParamInput = Record<string, string | string[] | undefined>;

function readSingle(searchParams: SearchParamInput, key: string): string | null {
  const value = searchParams[key];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function parseScope(raw: string | null): SessionFilterKey {
  if (raw === "archived" || raw === "active" || raw === "has-pr") {
    return raw;
  }
  return "all";
}

function parsePhase(raw: string | null): SessionPhase | null {
  if (!raw) return null;
  return (SESSION_PHASE_ORDER as readonly string[]).includes(raw) ? (raw as SessionPhase) : null;
}

export function parseSessionListQueryState(searchParams: SearchParamInput): SessionListQueryState {
  return {
    phase: parsePhase(readSingle(searchParams, "phase")),
    query: readSingle(searchParams, "q") ?? "",
    scope: parseScope(readSingle(searchParams, "scope")),
  };
}

function matchesQueryState(session: SessionSummary, queryState: SessionListQueryState): boolean {
  if (queryState.phase && session.phase !== queryState.phase) {
    return false;
  }
  if (queryState.scope === "archived" && !session.archivedAt) {
    return false;
  }
  if (queryState.scope === "active" && session.archivedAt) {
    return false;
  }
  if (queryState.scope === "has-pr" && session.pullRequestCount === 0) {
    return false;
  }
  if (queryState.query.trim()) {
    const q = queryState.query.trim().toLowerCase();
    const haystack =
      `${session.title} ${session.promptMd} ${session.linearIssueId ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) {
      return false;
    }
  }
  return true;
}

export async function loadSessionListPageData(
  workspaceSlug: string,
  searchParams: SearchParamInput,
): Promise<SessionListPageData> {
  const context = await loadSessionWorkspaceContext(workspaceSlug);
  const queryState = parseSessionListQueryState(searchParams);

  const { data, error } = await context.supabase
    .from("pipeline_issues")
    .select(
      `
        id,
        created_at,
        updated_at,
        issue_id,
        linear_issue_id,
        linear_issue_url,
        phase,
        phase_status,
        current_artifact_version,
        rejection_count,
        slack_channel_id,
        slack_thread_ts,
        workspace_id,
        issues:issue_id ( description_md, number, status, title )
      `,
    )
    .eq("workspace_id", context.workspace.id)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  type Row = (typeof data)[number] & {
    issues: {
      description_md: string;
      number: number;
      status: Tables<"issues">["status"];
      title: string;
    } | null;
  };

  const issueIds = ((data ?? []) as Row[])
    .map((row) => row.issue_id)
    .filter((id): id is string => Boolean(id));

  let prCountByIssue = new Map<string, number>();
  if (issueIds.length > 0) {
    const { data: prRows, error: prError } = await context.supabase
      .from("github_issue_branches")
      .select("issue_id")
      .eq("workspace_id", context.workspace.id)
      .in("issue_id", issueIds);
    if (prError) {
      throw prError;
    }
    const counts = new Map<string, number>();
    for (const row of (prRows ?? []) as Array<{ issue_id: string | null }>) {
      if (!row.issue_id) continue;
      counts.set(row.issue_id, (counts.get(row.issue_id) ?? 0) + 1);
    }
    prCountByIssue = counts;
  }

  const sessions = ((data ?? []) as Row[])
    .map((row) => mapPipelineRowToSession(row, prCountByIssue.get(row.issue_id) ?? 0))
    .filter((session) => session.number > 0);

  const filtered = sessions.filter((session) => matchesQueryState(session, queryState));

  return {
    queryState,
    sessions: filtered,
    totalCount: sessions.length,
    workspace: context.workspace,
  };
}
