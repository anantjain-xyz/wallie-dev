import { parseSessionBrowseReturn } from "@/lib/sessions/browse-return";
import { sessionReviewReturnPath } from "@/lib/sessions/review-link";
import {
  boundedReturnPath,
  localReturnUrl,
  returnQueryFor,
  workspaceListReturnPath,
} from "@/lib/workspace-list-return-path";

export const WORKSPACE_RETURN_HEADER = "x-wallie-workspace-return";

const sessionDetailQuery = [
  "artifactStage",
  "artifactId",
  "artifactVersion",
  "reviewStageId",
  "reviewRevision",
  "clarificationId",
];

export function workspaceReturnPath(value: string | null | undefined, expectedSlug?: string) {
  const url = localReturnUrl(value) ?? localReturnUrl(value?.split("?")[0]);
  if (!url) return;
  const match = /^\/w\/([a-z0-9-]+)(?:\/(.*))?$/.exec(url.pathname);
  if (!match || (expectedSlug !== undefined && match[1] !== expectedSlug)) return;
  const [, slug, route = ""] = match;
  const list =
    workspaceListReturnPath(`${url.pathname}${url.search}`, slug, true) ??
    workspaceListReturnPath(url.pathname, slug, true);
  if (list) return list;

  if (/^sessions\/[1-9][0-9]*\/?$/.test(route)) {
    const reviewSearch = new URLSearchParams(url.searchParams);
    const rawReturn = reviewSearch.getAll("returnTo");
    reviewSearch.delete("returnTo");
    const exact = sessionReviewReturnPath(
      { pathname: url.pathname, searchParams: reviewSearch },
      slug,
    );
    const returnTo =
      rawReturn.length === 1
        ? workspaceListReturnPath(parseSessionBrowseReturn(slug, rawReturn[0])?.href, slug, true)
        : undefined;
    const query = exact
      ? new URLSearchParams(exact.split("?")[1])
      : returnQueryFor(url, sessionDetailQuery);
    if (returnTo) query.set("returnTo", returnTo);
    return boundedReturnPath(url.pathname, query);
  }

  const query = returnQueryFor(url, ["factory"]);
  return boundedReturnPath(url.pathname, query);
}

export function sanitizeAuthSessionNext(next: string) {
  if (!/^\/w\/[a-z0-9-]+\/sessions(?:\/|\?|#|$)/.test(next)) return next;
  return workspaceReturnPath(next) ?? workspaceReturnPath(next.split(/[?#]/)[0]) ?? "/";
}
