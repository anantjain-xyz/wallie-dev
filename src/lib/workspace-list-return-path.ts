import { SESSION_LIST_STATUS_OPTIONS } from "@/features/sessions/list/sessions-list-query-state";
import { factoryInboxKinds } from "@/lib/factories/inbox-kinds";

export const SESSION_SEARCH_RESUME_PARAM = "resumeSearch";

const origin = "https://wallie.invalid";
const maxPathLength = 4_096;
const sessionsQuery = ["factory", "scope", "stage", "sort", "status", "cursor"];
const sessionsBrowseQuery = [...sessionsQuery, "q"];
const sessionsAuthQuery = [...sessionsQuery, SESSION_SEARCH_RESUME_PARAM];
const inboxQuery = ["factory", "kind", "cursor"];

export function localReturnUrl(path: string | null | undefined) {
  if (!path?.startsWith("/") || path.startsWith("//") || path.length > maxPathLength) return null;
  const url = URL.parse(path, origin);
  return url?.origin === origin && !url.hash && url.pathname.length <= maxPathLength ? url : null;
}

export function returnQueryFor(url: URL, keys: readonly string[]) {
  const search = new URLSearchParams();
  for (const key of keys) {
    for (const value of url.searchParams.getAll(key)) search.append(key, value);
  }
  return search;
}

export function boundedReturnPath(pathname: string, query: URLSearchParams) {
  const result = query.size ? `${pathname}?${query}` : pathname;
  return result.length <= maxPathLength ? result : pathname;
}

export function isSessionSearchMarker(value: string | undefined) {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

export function workspaceListReturnPath(
  value: string | null | undefined,
  workspaceSlug: string,
  auth = false,
) {
  const url = localReturnUrl(value);
  if (!url) return;
  const listPath = url.pathname.replace(/\/$/, "");
  const base = `/w/${workspaceSlug}`;
  const keys =
    listPath === `${base}/sessions`
      ? auth
        ? sessionsAuthQuery
        : sessionsBrowseQuery
      : listPath === `${base}/inbox`
        ? inboxQuery
        : null;
  if (!keys) return;
  const query = returnQueryFor(url, keys);
  if (listPath === `${base}/sessions`) {
    const status = SESSION_LIST_STATUS_OPTIONS.find((option) => option === query.get("status"));
    if (status) query.set("status", status);
    else query.delete("status");
    if (auth) {
      const markers = query.getAll(SESSION_SEARCH_RESUME_PARAM);
      if (markers.length !== 1 || !isSessionSearchMarker(markers[0])) {
        query.delete(SESSION_SEARCH_RESUME_PARAM);
      }
    }
  } else {
    const kinds = query.getAll("kind");
    if (kinds.length !== 1 || !factoryInboxKinds.some((kind) => kind === kinds[0])) {
      query.delete("kind");
    }
  }
  return boundedReturnPath(listPath, query);
}
