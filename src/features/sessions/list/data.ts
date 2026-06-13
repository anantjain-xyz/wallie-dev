import "server-only";

import type { WorkspaceSummary } from "@/lib/auth";
import { mapOnboardingResumeState, type OnboardingResumeState } from "@/features/onboarding/flow";
import { loadSessionWorkspaceContext } from "@/features/sessions/server";
import { mapSessionRow } from "@/features/sessions/model";
import {
  type SessionFilterKey,
  type SessionListQueryState,
  type SessionSummary,
} from "@/features/sessions/types";

export type SessionListPageData = {
  onboarding: OnboardingResumeState | null;
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

export function parseSessionListQueryState(searchParams: SearchParamInput): SessionListQueryState {
  // Stage filter is a free-form slug now (workspaces can define their own
  // stages); we surface whatever's in the URL and let the dashboard decide
  // what to render for unknown slugs.
  return {
    query: readSingle(searchParams, "q") ?? "",
    scope: parseScope(readSingle(searchParams, "scope")),
    stageSlug: readSingle(searchParams, "stage"),
  };
}

function matchesQueryState(session: SessionSummary, queryState: SessionListQueryState): boolean {
  if (queryState.stageSlug && session.currentStageSlug !== queryState.stageSlug) {
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

  const { data: onboardingRow, error: onboardingError } = await context.supabase
    .from("workspace_onboarding")
    .select("current_step, status")
    .eq("workspace_id", context.workspace.id)
    .maybeSingle();
  if (onboardingError) {
    throw onboardingError;
  }

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
        pipeline_id,
        current_stage_id,
        phase_status,
        current_artifact_version,
        prompt_md,
        rejection_count,
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

  // Resolve the (slug, name) of each session's current stage in a single
  // query. Sessions in this workspace may pin to multiple pipelines, so we
  // index by stage id rather than assuming one pipeline.
  const stageIds = Array.from(new Set(rows.map((r) => r.current_stage_id))).filter(Boolean);
  const stageMap = new Map<string, { name: string; position: number; slug: string }>();
  if (stageIds.length > 0) {
    const { data: stageRows, error: stageError } = await context.supabase
      .from("pipeline_stages")
      .select("id, slug, name, position")
      .in("id", stageIds);
    if (stageError) throw stageError;
    for (const s of stageRows ?? []) {
      stageMap.set(s.id, { name: s.name, position: s.position, slug: s.slug });
    }
  }

  const sessionIds = rows.map((row) => row.id);

  const pullRequestsBySession = new Map<string, SessionSummary["pullRequests"]>();
  if (sessionIds.length > 0) {
    const { data: prRows, error: prError } = await context.supabase
      .from("session_pull_requests")
      .select(
        "id, session_id, branch_name, is_draft, pull_request_number, pull_request_state, pull_request_url, updated_at",
      )
      .eq("workspace_id", context.workspace.id)
      .in("session_id", sessionIds)
      .order("created_at", { ascending: false });
    if (prError) {
      throw prError;
    }
    for (const row of prRows ?? []) {
      const list = pullRequestsBySession.get(row.session_id) ?? [];
      list.push({
        branchName: row.branch_name,
        id: row.id,
        isDraft: row.is_draft,
        pullRequestNumber: row.pull_request_number,
        pullRequestState: row.pull_request_state,
        pullRequestUrl: row.pull_request_url,
        repositoryFullName: null,
        repositoryHtmlUrl: null,
        updatedAt: row.updated_at,
      });
      pullRequestsBySession.set(row.session_id, list);
    }
  }

  const sessions = rows
    .map((row) => {
      const stage = stageMap.get(row.current_stage_id) ?? {
        name: "Unknown",
        // Unknown stages sort after every real pipeline position.
        position: Number.MAX_SAFE_INTEGER,
        slug: "unknown",
      };
      const pullRequests = pullRequestsBySession.get(row.id) ?? [];
      return mapSessionRow(row, stage, pullRequests.length, pullRequests);
    })
    .filter((session) => session.number > 0);

  const filtered = sessions.filter((session) => matchesQueryState(session, queryState));

  return {
    onboarding: mapOnboardingResumeState(onboardingRow),
    queryState,
    sessions: filtered,
    totalCount: sessions.length,
    workspace: context.workspace,
  };
}
