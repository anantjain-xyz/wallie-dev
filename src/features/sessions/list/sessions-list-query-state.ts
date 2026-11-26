import type { SessionDisplayStatus } from "@/features/sessions/display-status";
import type {
  SessionFilterKey,
  SessionListQueryState,
  SessionListSortKey,
} from "@/features/sessions/types";
import { readFirstValue } from "@/lib/utils";

export type SessionListSearchParams = Record<string, string | string[] | undefined>;

export const SESSION_LIST_DEFAULT_SCOPE: SessionFilterKey = "active";
export const SESSION_LIST_DEFAULT_SORT: SessionListSortKey = "updated";

export const SESSION_LIST_DEFAULT_FILTERS = {
  scope: SESSION_LIST_DEFAULT_SCOPE,
  sort: SESSION_LIST_DEFAULT_SORT,
  stageSlug: null,
} as const satisfies Pick<SessionListQueryState, "scope" | "sort" | "stageSlug">;

export const SESSION_LIST_STATUS_OPTIONS = [
  "awaiting_review",
  "in_progress",
  "approved",
  "rejected",
  "failed",
] as const satisfies readonly SessionDisplayStatus[];

const SESSION_LIST_STICKY_PARAM_KEYS = ["scope", "stage", "sort", "status"] as const;

function readSingle(searchParams: SessionListSearchParams, key: string): string | null {
  return readFirstValue(searchParams[key]) ?? null;
}

export function parseSessionListScope(raw: string | null | undefined): SessionFilterKey {
  if (raw === "active" || raw === "archived" || raw === "all") {
    return raw;
  }
  return SESSION_LIST_DEFAULT_SCOPE;
}

export function parseSessionListSort(raw: string | null | undefined): SessionListSortKey {
  if (raw === "oldest" || raw === "number" || raw === "updated") {
    return raw;
  }
  return SESSION_LIST_DEFAULT_SORT;
}

export function parseSessionListQueryState(
  searchParams: SessionListSearchParams,
): SessionListQueryState {
  // Stage filter is a free-form slug now (workspaces can define their own
  // stages); we surface whatever's in the URL and let the dashboard decide
  // what to render for unknown slugs.
  const status = SESSION_LIST_STATUS_OPTIONS.find(
    (option) => option === readSingle(searchParams, "status"),
  );
  return {
    cursor: readSingle(searchParams, "cursor"),
    query: readSingle(searchParams, "q") ?? "",
    scope: parseSessionListScope(readSingle(searchParams, "scope")),
    sort: parseSessionListSort(readSingle(searchParams, "sort")),
    stageSlug: readSingle(searchParams, "stage"),
    ...(status ? { status } : {}),
  };
}

export function sessionListSearchHasStickyParams(search: URLSearchParams): boolean {
  return SESSION_LIST_STICKY_PARAM_KEYS.some((key) => search.has(key));
}

export function areDefaultSessionListFilters(
  filters: Pick<SessionListQueryState, "scope" | "sort" | "stageSlug" | "status">,
): boolean {
  return (
    filters.scope === SESSION_LIST_DEFAULT_SCOPE &&
    filters.sort === SESSION_LIST_DEFAULT_SORT &&
    !filters.stageSlug &&
    !filters.status
  );
}
