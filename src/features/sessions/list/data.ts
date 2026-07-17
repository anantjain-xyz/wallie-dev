import "server-only";

import type { WorkspaceSummary } from "@/lib/auth";
import type { OnboardingResumeState } from "@/features/onboarding/resume";
import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";
import {
  type SessionFilterKey,
  type SessionListItem,
  type SessionListQueryState,
} from "@/features/sessions/types";
import { approximatePayloadSizeBytes, withServerTiming } from "@/lib/server-timing";

export type SessionListPageData = {
  hasAnySession: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  onboarding: OnboardingResumeState | null;
  queryState: SessionListQueryState;
  sessions: SessionListItem[];
  stageFacets: SessionStageFacet[];
  totalCount: number;
  workspace: WorkspaceSummary;
};

export type SessionStageFacet = {
  count: number;
  name: string;
  position: number;
  slug: string;
};

type SearchParamInput = Record<string, string | string[] | undefined>;
type Cursor = {
  id: string;
  updatedAt: string;
};
type SessionListRpcPayload = {
  hasAnySession?: boolean;
  hasMore?: boolean;
  sessions?: SessionListItem[];
  stageFacets?: SessionStageFacet[];
};

const SESSION_LIST_PAGE_SIZE = 50;

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
    cursor: readSingle(searchParams, "cursor"),
    query: readSingle(searchParams, "q") ?? "",
    scope: parseScope(readSingle(searchParams, "scope")),
    stageSlug: readSingle(searchParams, "stage"),
  };
}

function decodeCursor(raw: string | null): Cursor | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.id !== "string" || typeof parsed.updatedAt !== "string") {
      return null;
    }
    return {
      id: parsed.id,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function encodeCursor(row: Pick<SessionListItem, "id" | "updatedAt">) {
  return Buffer.from(
    JSON.stringify({
      id: row.id,
      updatedAt: row.updatedAt,
    } satisfies Cursor),
  ).toString("base64url");
}

export async function loadSessionListPageData(
  workspaceSlug: string,
  searchParams: SearchParamInput,
): Promise<SessionListPageData> {
  const queryState = parseSessionListQueryState(searchParams);
  const cursor = decodeCursor(queryState.cursor);

  return withServerTiming(
    "sessions.list",
    {
      cursor: cursor ? "present" : "none",
      hasQuery: queryState.query.trim().length > 0,
      scope: queryState.scope,
      stageSlug: queryState.stageSlug,
      workspaceSlug,
    },
    async (timing) => {
      const context = await timing.segment(
        "workspace-layout-context",
        () => loadWorkspaceLayoutContext(workspaceSlug),
        (resolvedContext) => ({
          payloadBytes: approximatePayloadSizeBytes({
            defaultSessionGithubRepositoryId: resolvedContext.defaultSessionGithubRepositoryId,
            onboarding: resolvedContext.onboarding,
            workspace: resolvedContext.workspace,
          }),
          rows: 1,
        }),
      );

      const { data: rpcData, error: rpcError } = await timing.segment(
        "sessions.list-rpc",
        () =>
          context.supabase.rpc("get_session_list_page", {
            cursor_id: cursor?.id,
            cursor_updated_at: cursor?.updatedAt,
            page_limit: SESSION_LIST_PAGE_SIZE,
            search_query: queryState.query.trim() || undefined,
            session_scope: queryState.scope,
            stage_filter_slug: queryState.stageSlug ?? undefined,
            target_workspace_slug: workspaceSlug,
          }),
        (result) => {
          const payload = result.data as SessionListRpcPayload | null;
          return {
            payloadBytes: approximatePayloadSizeBytes(result.data),
            rows: Array.isArray(payload?.sessions) ? payload.sessions.length : 0,
          };
        },
      );

      if (rpcError) throw rpcError;

      const payload = (rpcData ?? {}) as SessionListRpcPayload;
      const sessions = (payload.sessions ?? []).filter((session) => session.number > 0);
      const stageFacets = payload.stageFacets ?? [];
      const hasMore = payload.hasMore === true;
      const nextCursor = hasMore && sessions.length > 0 ? encodeCursor(sessions.at(-1)!) : null;

      return {
        hasAnySession: payload.hasAnySession === true,
        hasMore,
        nextCursor,
        onboarding: context.onboarding,
        queryState,
        sessions,
        stageFacets,
        totalCount: sessions.length,
        workspace: context.workspace,
      };
    },
  );
}
