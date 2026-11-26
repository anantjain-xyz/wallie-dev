import { emailCodeAuthCookieOptions } from "@/lib/auth-email-code-cookie";
import {
  isSessionSearchMarker,
  SESSION_SEARCH_RESUME_PARAM,
  workspaceReturnPath,
} from "@/lib/workspace-return-path";

export const sessionSearchCookieName = "wallie_session_search";
export const sessionSearchCookieOptions = emailCodeAuthCookieOptions;

const origin = "https://wallie.invalid";
const maxCookieValueLength = 3_700;

function sessionsUrl(path: string) {
  const url = URL.parse(path, origin);
  if (!url || url.origin !== origin || !/^\/w\/[a-z0-9-]+\/sessions\/?$/.test(url.pathname)) {
    return null;
  }
  return url;
}

export function createSessionSearchContinuation(next: string, query: string | null) {
  if (!query?.trim() || query.length > maxCookieValueLength) return null;
  const destination = sessionsUrl(next);
  if (!destination) return null;
  destination.searchParams.delete(SESSION_SEARCH_RESUME_PARAM);
  const returnPath = workspaceReturnPath(destination.pathname + destination.search);
  if (!returnPath) return null;

  const marker = crypto.randomUUID();
  const cookie = JSON.stringify({
    marker,
    returnPath,
    query,
    expiresAt: Date.now() + sessionSearchCookieOptions.maxAge * 1_000,
  });
  if (encodeURIComponent(cookie).length > maxCookieValueLength) return null;
  const url = new URL(returnPath, origin);
  url.searchParams.set(SESSION_SEARCH_RESUME_PARAM, marker);
  const withMarker = workspaceReturnPath(url.pathname + url.search);
  if (withMarker !== url.pathname + url.search) return null;
  return { next: withMarker, cookie };
}

export function readSessionSearchContinuation(next: string, cookie: string | undefined) {
  const destination = sessionsUrl(next);
  const markers = destination?.searchParams.getAll(SESSION_SEARCH_RESUME_PARAM);
  if (
    !destination ||
    markers?.length !== 1 ||
    !isSessionSearchMarker(markers[0]) ||
    !cookie ||
    cookie.length > maxCookieValueLength
  ) {
    return null;
  }
  destination.searchParams.delete(SESSION_SEARCH_RESUME_PARAM);
  const returnPath = workspaceReturnPath(destination.pathname + destination.search);
  try {
    const saved: unknown = JSON.parse(cookie);
    if (
      !saved ||
      typeof saved !== "object" ||
      !("marker" in saved) ||
      saved.marker !== markers[0] ||
      !("returnPath" in saved) ||
      saved.returnPath !== returnPath ||
      !("expiresAt" in saved) ||
      typeof saved.expiresAt !== "number" ||
      !Number.isFinite(saved.expiresAt) ||
      saved.expiresAt <= Date.now() ||
      !("query" in saved) ||
      typeof saved.query !== "string"
    )
      return null;
    return saved.query;
  } catch {
    return null;
  }
}
