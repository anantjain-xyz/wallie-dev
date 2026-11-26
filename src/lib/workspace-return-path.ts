import { sessionReviewReturnPath } from "@/lib/sessions/review-link";

export const WORKSPACE_RETURN_HEADER = "x-wallie-workspace-return";
export const SESSION_SEARCH_RESUME_PARAM = "resumeSearch";

const origin = "https://wallie.invalid";
const maxPathLength = 4_096;
const sessionsQuery = ["factory", "scope", "stage", "sort", "q", "cursor"];
const sessionsAuthQuery = [
  "factory",
  "scope",
  "stage",
  "sort",
  "cursor",
  SESSION_SEARCH_RESUME_PARAM,
];
const inboxQuery = ["factory", "cursor"];
const sessionDetailQuery = [
  "artifactStage",
  "artifactId",
  "artifactVersion",
  "reviewStageId",
  "reviewRevision",
  "clarificationId",
  "returnTo",
];

function localUrl(path: string | null | undefined) {
  if (!path?.startsWith("/") || path.startsWith("//") || path.length > maxPathLength) return null;
  const url = URL.parse(path, origin);
  return url?.origin === origin && !url.hash && url.pathname.length <= maxPathLength ? url : null;
}

function queryFor(url: URL, keys: readonly string[]) {
  const search = new URLSearchParams();
  for (const key of keys) {
    for (const value of url.searchParams.getAll(key)) search.append(key, value);
  }
  return search;
}

function boundedPath(pathname: string, query: URLSearchParams) {
  const result = query.size ? `${pathname}?${query}` : pathname;
  return result.length <= maxPathLength ? result : pathname;
}

export function workspaceListReturnPath(
  value: string | null | undefined,
  workspaceSlug: string,
  auth = false,
) {
  const url = localUrl(value);
  if (!url) return;
  const listPath = url.pathname.replace(/\/$/, "");
  const base = `/w/${workspaceSlug}`;
  const keys =
    listPath === `${base}/sessions`
      ? auth
        ? sessionsAuthQuery
        : sessionsQuery
      : listPath === `${base}/inbox`
        ? inboxQuery
        : null;
  if (!keys) return;
  const query = queryFor(url, keys);
  if (auth && listPath === `${base}/sessions`) {
    const markers = query.getAll(SESSION_SEARCH_RESUME_PARAM);
    if (markers.length !== 1 || !isSessionSearchMarker(markers[0])) {
      query.delete(SESSION_SEARCH_RESUME_PARAM);
    }
  }
  return boundedPath(listPath, query);
}

export function workspaceReturnPath(value: string | null | undefined, expectedSlug?: string) {
  const url = localUrl(value) ?? localUrl(value?.split("?")[0]);
  if (!url) return;
  const match = /^\/w\/([a-z0-9-]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match || (expectedSlug !== undefined && match[1] !== expectedSlug)) return;
  const [, slug, route = ""] = match;
  const list =
    workspaceListReturnPath(`${url.pathname}${url.search}`, slug, true) ??
    workspaceListReturnPath(url.pathname, slug, true);
  if (list) return list;

  if (/^sessions\/[1-9][0-9]*\/?$/.test(route)) {
    const exact = sessionReviewReturnPath(url, slug);
    const returnTo = workspaceListReturnPath(url.searchParams.get("returnTo"), slug, true);
    const query = exact
      ? new URLSearchParams(exact.split("?")[1])
      : queryFor(url, sessionDetailQuery);
    query.delete("returnTo");
    if (returnTo) query.set("returnTo", returnTo);
    return boundedPath(url.pathname, query);
  }

  const query = queryFor(url, ["factory"]);
  return boundedPath(url.pathname, query);
}

export function isSessionSearchMarker(value: string | undefined) {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}

export function sanitizeAuthSessionNext(next: string) {
  if (!/^\/w\/[a-z0-9-]+\/sessions(?:\/|\?|#|$)/.test(next)) return next;
  return workspaceReturnPath(next) ?? workspaceReturnPath(next.split(/[?#]/)[0]) ?? "/";
}
