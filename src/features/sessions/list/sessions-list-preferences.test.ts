// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readSessionListPreferences,
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
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a valid payload for the workspace key", () => {
    writeSessionListPreferences("acme", storedAll);

    expect(window.localStorage.getItem(sessionListPreferencesStorageKey("acme"))).toBe(
      JSON.stringify(storedAll),
    );
    expect(readSessionListPreferences("acme")).toEqual(storedAll);
    expect(readSessionListPreferences("other")).toBeNull();
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

  it("ignores quota and thrown getItem failures", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSessionListPreferences("acme")).toBeNull();
    vi.mocked(Storage.prototype.getItem).mockRestore();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
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
