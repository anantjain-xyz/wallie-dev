import "server-only";

import type { WorkspaceSummary } from "@/lib/auth";
import { loadSessionWorkspaceContext } from "@/features/sessions/server";
import { mapSessionRow } from "@/features/sessions/model";
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
    .from("sessions")
    .select(
      `
        id,
        archived_at,
        created_at,
        updated_at,
        linear_issue_id,
        linear_issue_url,
        number,
        phase,
        phase_status,
        current_artifact_version,
        prompt_md,
        rejection_count,
        slack_channel_id,
        slack_thread_ts,
        title,
        workspace_id
      `,
    )
    .eq("workspace_id", context.workspace.id)
    .order("updated_at", { ascending: false });

  if (error) {
    throw error;
  }

  const rows = data ?? [];

  const sessionIds = rows.map((row) => row.id);

  const prCountBySession = new Map<string, number>();
  if (sessionIds.length > 0) {
    const { data: prRows, error: prError } = await context.supabase
      .from("github_issue_branches")
      .select("session_id")
      .eq("workspace_id", context.workspace.id)
      .in("session_id", sessionIds);
    if (prError) {
      throw prError;
    }
    for (const row of (prRows ?? []) as Array<{ session_id: string }>) {
      prCountBySession.set(row.session_id, (prCountBySession.get(row.session_id) ?? 0) + 1);
    }
  }

  const sessions = rows
    .map((row) => mapSessionRow(row, prCountBySession.get(row.id) ?? 0))
    .filter((session) => session.number > 0);

  const filtered = sessions.filter((session) => matchesQueryState(session, queryState));

  return {
    queryState,
    sessions: filtered,
    totalCount: sessions.length,
    workspace: context.workspace,
  };
}
