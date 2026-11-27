// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  parseBoardStatus,
  readBoardBrowseHistory,
  writeBoardBrowseHistory,
} from "@/features/pipeline/board-browse-history";

const board = "/w/wallie";
const historyScope = { factory: "all", pathname: board, viewerId: "owner" };

afterEach(() => window.history.replaceState(null, "", "/"));

describe("board browse history", () => {
  it("accepts one supported status and rejects a repeated or unrelated value", () => {
    expect(parseBoardStatus("awaiting_review")).toBe("awaiting_review");
    expect(parseBoardStatus("failed")).toBe("failed");
    expect(parseBoardStatus(["failed", "failed"])).toBe("all");
    expect(parseBoardStatus("archived")).toBe("all");
  });

  it("keeps search in memory and restores it only for the same viewer and factory", () => {
    window.history.replaceState(null, "", `${board}?factory=all#anchor`);
    const key = writeBoardBrowseHistory(historyScope, {
      searchQuery: "board only",
      status: "failed",
    });
    const stage = { key: "build", origin: "manual" } as const;
    expect(writeBoardBrowseHistory(historyScope, { stage })).toBe(key);

    expect(window.location.search).toBe("?factory=all&status=failed");
    expect(window.location.hash).toBe("#anchor");
    expect(window.history.state).toEqual({ wallieBoard: key });
    expect(typeof key).toBe("string");
    expect(key).not.toContain("board only");
    expect(readBoardBrowseHistory(historyScope)).toEqual({
      entryKey: key,
      searchQuery: "board only",
      stage,
      status: "failed",
    });
    expect(
      readBoardBrowseHistory({ ...historyScope, factory: "different-factory" })?.searchQuery,
    ).toBe("");
    expect(readBoardBrowseHistory({ ...historyScope, viewerId: "member" })?.searchQuery).toBe("");

    expect(writeBoardBrowseHistory(historyScope, { searchQuery: "", status: "all" })).toBe(key);
    expect(window.location.search).toBe("?factory=all");
    expect(readBoardBrowseHistory(historyScope)).toEqual({
      entryKey: key,
      searchQuery: "",
      stage,
      status: "all",
    });
  });

  it("assigns a new key to a different entry of the same Board", () => {
    window.history.replaceState(null, "", board);
    const oldKey = writeBoardBrowseHistory(historyScope, {
      stage: { key: "build", origin: "automatic" },
    });
    window.history.pushState(null, "", board);
    expect(readBoardBrowseHistory(historyScope)).toMatchObject({
      entryKey: undefined,
      stage: undefined,
    });
    expect(writeBoardBrowseHistory(historyScope, { status: "failed" })).not.toBe(oldKey);
  });

  it("pushes applied searches without putting the search term in the page URL", () => {
    window.history.replaceState(null, "", board);
    const firstKey = writeBoardBrowseHistory(historyScope, { searchQuery: "first" }, "push");
    const length = window.history.length;
    const secondKey = writeBoardBrowseHistory(historyScope, { searchQuery: "second" }, "push");
    expect(secondKey).not.toBe(firstKey);
    expect(window.history.length).toBe(length + 1);
    expect(window.location.pathname).toBe(board);
    expect(window.location.search).toBe("");
    expect(window.history.state).toEqual({ wallieBoard: secondKey });
    expect(readBoardBrowseHistory(historyScope)?.searchQuery).toBe("second");
    window.history.replaceState({ wallieBoard: firstKey }, "", board);
    expect(readBoardBrowseHistory(historyScope)?.searchQuery).toBe("first");
  });

  it("does not touch or read state on the List route", () => {
    window.history.replaceState(null, "", `${board}/sessions?scope=archived&q=list`);
    writeBoardBrowseHistory(historyScope, { searchQuery: "board only", status: "failed" });
    expect(window.location.search).toBe("?scope=archived&q=list");
    expect(readBoardBrowseHistory(historyScope)).toBeNull();
  });

  it("expires private state when leaving the document, including a cached document", () => {
    window.history.replaceState(null, "", board);
    writeBoardBrowseHistory(historyScope, {
      searchQuery: "board only",
      stage: { key: "build", origin: "automatic" },
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(readBoardBrowseHistory(historyScope)).toEqual({
      entryKey: undefined,
      searchQuery: "",
      stage: undefined,
      status: "all",
    });
  });
});
