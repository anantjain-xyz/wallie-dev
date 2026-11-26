import { sessionReviewReturnPath } from "@/lib/sessions/review-link";

export const WORKSPACE_RETURN_HEADER = "x-wallie-workspace-return";

const origin = "https://wallie.invalid";
const sessionsQuery = ["factory", "scope", "stage", "sort", "q", "cursor"];
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
  if (!path?.startsWith("/") || path.startsWith("//") || path.length > 4_096) return null;
  const url = URL.parse(path, origin);
  return url?.origin === origin && !url.hash ? url : null;
}

function queryFor(url: URL, keys: readonly string[]) {
  const search = new URLSearchParams();
  for (const key of keys) {
    for (const value of url.searchParams.getAll(key)) search.append(key, value);
  }
  return search;
}

export function workspaceListReturnPath(value: string | null | undefined, workspaceSlug: string) {
  const url = localUrl(value);
  if (!url) return;
  const listPath = url.pathname.replace(/\/$/, "");
  const base = `/w/${workspaceSlug}`;
  const keys =
    listPath === `${base}/sessions`
      ? sessionsQuery
      : listPath === `${base}/inbox`
        ? inboxQuery
        : null;
  if (!keys) return;
  const query = queryFor(url, keys);
  return query.size ? `${listPath}?${query}` : listPath;
}

export function workspaceReturnPath(value: string | null | undefined, expectedSlug?: string) {
  const url = localUrl(value);
  if (!url) return;
  const match = /^\/w\/([a-z0-9-]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match || (expectedSlug !== undefined && match[1] !== expectedSlug)) return;
  const [, slug, route = ""] = match;
  const list = workspaceListReturnPath(`${url.pathname}${url.search}`, slug);
  if (list) return list;

  if (/^sessions\/[1-9][0-9]*\/?$/.test(route)) {
    const exact = sessionReviewReturnPath(url, slug);
    const returnTo = workspaceListReturnPath(url.searchParams.get("returnTo"), slug);
    const query = exact
      ? new URLSearchParams(exact.split("?")[1])
      : queryFor(url, sessionDetailQuery);
    query.delete("returnTo");
    if (returnTo) query.set("returnTo", returnTo);
    return query.size ? `${url.pathname}?${query}` : url.pathname;
  }

  const query = queryFor(url, ["factory"]);
  return query.size ? `${url.pathname}?${query}` : url.pathname;
}
