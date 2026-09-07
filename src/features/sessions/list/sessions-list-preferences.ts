import {
  areDefaultSessionListFilters,
  sessionListSearchHasStickyParams,
} from "@/features/sessions/list/sessions-list-query-state";
import type {
  SessionFilterKey,
  SessionListQueryState,
  SessionListSortKey,
} from "@/features/sessions/types";

export type SessionListFilterPreferences = {
  scope: SessionFilterKey;
  sort: SessionListSortKey;
  stageSlug: string | null;
};

export function sessionListPreferencesStorageKey(workspaceSlug: string): string {
  return `wallie-sessions-list-filters:v1:${workspaceSlug}`;
}

export function sessionListPreferencesCookieName(workspaceSlug: string): string {
  return `wallie-sessions-list-filters-v1-${encodeURIComponent(workspaceSlug)}`;
}

export function parseSessionListPreferencesCookie(
  value: string | undefined,
): SessionListFilterPreferences | null {
  if (!value) return null;
  try {
    return parseStoredPreferences(JSON.parse(decodeURIComponent(value)));
  } catch {
    return null;
  }
}

function parseStoredPreferences(value: unknown): SessionListFilterPreferences | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.scope !== "active" && record.scope !== "archived" && record.scope !== "all") {
    return null;
  }
  if (record.sort !== "updated" && record.sort !== "oldest" && record.sort !== "number") {
    return null;
  }
  if (record.stageSlug !== null && typeof record.stageSlug !== "string") {
    return null;
  }

  return {
    scope: record.scope,
    sort: record.sort,
    stageSlug: record.stageSlug === "" ? null : record.stageSlug,
  };
}

export function readSessionListPreferences(
  workspaceSlug: string,
): SessionListFilterPreferences | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const prefix = `${sessionListPreferencesCookieName(workspaceSlug)}=`;
    const cookie = document.cookie.split("; ").find((entry) => entry.startsWith(prefix));
    const preferences = parseSessionListPreferencesCookie(cookie?.slice(prefix.length));
    if (preferences) return preferences;

    // Read the old browser-only format solely for migration, never navigation.
    const raw = window.localStorage.getItem(sessionListPreferencesStorageKey(workspaceSlug));
    if (!raw) {
      return null;
    }
    return parseStoredPreferences(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeSessionListPreferences(
  workspaceSlug: string,
  preferences: SessionListFilterPreferences,
): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    const value = encodeURIComponent(
      JSON.stringify({
        scope: preferences.scope,
        sort: preferences.sort,
        stageSlug: preferences.stageSlug,
      } satisfies SessionListFilterPreferences),
    );
    document.cookie = `${sessionListPreferencesCookieName(workspaceSlug)}=${value}; Path=/w/${encodeURIComponent(workspaceSlug)}; Max-Age=31536000; SameSite=Lax${window.location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {
    // Blocked browser storage must not prevent filter navigation.
  }
}

export function shouldRestoreSessionListPreferences({
  queryState,
  search,
  stored,
}: {
  queryState: SessionListQueryState;
  search: URLSearchParams;
  stored: SessionListFilterPreferences | null;
}): boolean {
  if (!stored || areDefaultSessionListFilters(stored)) {
    return false;
  }
  if (queryState.cursor || search.has("cursor")) {
    return false;
  }
  if (sessionListSearchHasStickyParams(search)) {
    return false;
  }
  return areDefaultSessionListFilters(queryState);
}
