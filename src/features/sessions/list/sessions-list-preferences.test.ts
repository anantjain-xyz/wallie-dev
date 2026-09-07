// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readSessionListPreferences,
  sessionListPreferencesCookieName,
  parseSessionListPreferencesCookie,
  sessionListPreferencesStorageKey,
  shouldRestoreSessionListPreferences,
  writeSessionListPreferences,
} from "@/features/sessions/list/sessions-list-preferences";
import type { SessionListQueryState } from "@/features/sessions/types";

const defaultQueryState: SessionListQueryState = {
  cursor: null,
  query: "",
  scope: "active",
  sort: "updated",
  stageSlug: null,
};

const storedAll = {
  scope: "all",
  sort: "oldest",
  stageSlug: "build",
} as const;

describe("sessions list preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/w/acme/sessions");
    document.cookie = `${sessionListPreferencesCookieName("acme")}=; Path=/w/acme; Max-Age=0`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/w/acme/sessions");
    document.cookie = `${sessionListPreferencesCookieName("acme")}=; Path=/w/acme; Max-Age=0`;
  });

  it("round-trips a valid payload for the workspace key", () => {
    writeSessionListPreferences("acme", storedAll);

    expect(document.cookie).toContain(
      `${sessionListPreferencesCookieName("acme")}=${encodeURIComponent(JSON.stringify(storedAll))}`,
    );
    expect(window.localStorage.getItem(sessionListPreferencesStorageKey("acme"))).toBeNull();
    expect(readSessionListPreferences("acme")).toEqual(storedAll);
    expect(readSessionListPreferences("other")).toBeNull();
  });

  it("validates cookie payloads on the server", () => {
    expect(
      parseSessionListPreferencesCookie(encodeURIComponent(JSON.stringify(storedAll))),
    ).toEqual(storedAll);
    for (const value of [
      undefined,
      "%",
      "{not-json",
      "null",
      encodeURIComponent(JSON.stringify({ ...storedAll, scope: "bad" })),
      encodeURIComponent(JSON.stringify({ ...storedAll, sort: "bad" })),
    ]) {
      expect(parseSessionListPreferencesCookie(value)).toBeNull();
    }
  });

  it("prefers the cookie over legacy storage and scopes it to the workspace path", () => {
    window.localStorage.setItem(
      sessionListPreferencesStorageKey("acme"),
      JSON.stringify({ ...storedAll, scope: "archived" }),
    );
    writeSessionListPreferences("acme", storedAll);
    expect(readSessionListPreferences("acme")).toEqual(storedAll);
    window.history.replaceState(null, "", "/w/other/sessions");
    expect(document.cookie).not.toContain(sessionListPreferencesCookieName("acme"));
  });

  it("rejects unknown scope or sort and malformed JSON", () => {
    window.localStorage.setItem(
      sessionListPreferencesStorageKey("acme"),
      JSON.stringify({ ...storedAll, scope: "unknown" }),
    );
    expect(readSessionListPreferences("acme")).toBeNull();

    window.localStorage.setItem(
      sessionListPreferencesStorageKey("acme"),
      JSON.stringify({ ...storedAll, sort: "bogus" }),
    );
    expect(readSessionListPreferences("acme")).toBeNull();

    window.localStorage.setItem(sessionListPreferencesStorageKey("acme"), "{not-json");
    expect(readSessionListPreferences("acme")).toBeNull();
  });

  it("ignores blocked legacy storage and cookie writes", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSessionListPreferences("acme")).toBeNull();
    vi.mocked(Storage.prototype.getItem).mockRestore();

    vi.spyOn(document, "cookie", "set").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeSessionListPreferences("acme", storedAll)).not.toThrow();
  });

  it("restores only when the URL omitted sticky keys and stored prefs are not defaults", () => {
    expect(
      shouldRestoreSessionListPreferences({
        queryState: defaultQueryState,
        search: new URLSearchParams(),
        stored: storedAll,
      }),
    ).toBe(true);

    expect(
      shouldRestoreSessionListPreferences({
        queryState: { ...defaultQueryState, query: "auth" },
        search: new URLSearchParams("q=auth"),
        stored: { scope: "all", sort: "updated", stageSlug: null },
      }),
    ).toBe(true);

    expect(
      shouldRestoreSessionListPreferences({
        queryState: defaultQueryState,
        search: new URLSearchParams("create=1"),
        stored: storedAll,
      }),
    ).toBe(true);

    expect(
      shouldRestoreSessionListPreferences({
        queryState: defaultQueryState,
        search: new URLSearchParams(),
        stored: { scope: "active", sort: "updated", stageSlug: null },
      }),
    ).toBe(false);

    expect(
      shouldRestoreSessionListPreferences({
        queryState: { ...defaultQueryState, scope: "archived" },
        search: new URLSearchParams("scope=archived"),
        stored: storedAll,
      }),
    ).toBe(false);

    expect(
      shouldRestoreSessionListPreferences({
        queryState: { ...defaultQueryState, cursor: "page-2" },
        search: new URLSearchParams("cursor=page-2"),
        stored: storedAll,
      }),
    ).toBe(false);

    expect(
      shouldRestoreSessionListPreferences({
        queryState: { ...defaultQueryState, stageSlug: "build" },
        search: new URLSearchParams(),
        stored: storedAll,
      }),
    ).toBe(false);
  });
});
