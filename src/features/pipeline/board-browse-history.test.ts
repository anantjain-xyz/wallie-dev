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
    writeBoardBrowseHistory(historyScope, { searchQuery: "board only", status: "failed" });
    const key = window.history.state.wallieBoard;
    writeBoardBrowseHistory(historyScope, { laneKey: "build" });

    expect(window.location.search).toBe("?factory=all&status=failed");
    expect(window.location.hash).toBe("#anchor");
    expect(window.history.state).toEqual({ wallieBoard: key });
    expect(typeof key).toBe("string");
    expect(key).not.toContain("board only");
    expect(readBoardBrowseHistory(historyScope)).toEqual({
      laneKey: "build",
      searchQuery: "board only",
      status: "failed",
    });
    expect(
      readBoardBrowseHistory({ ...historyScope, factory: "different-factory" })?.searchQuery,
    ).toBe("");
    expect(readBoardBrowseHistory({ ...historyScope, viewerId: "member" })?.searchQuery).toBe("");

    writeBoardBrowseHistory(historyScope, { searchQuery: "", status: "all" });
    expect(window.location.search).toBe("?factory=all");
    expect(readBoardBrowseHistory(historyScope)).toEqual({
      laneKey: "build",
      searchQuery: "",
      status: "all",
    });
  });

  it("does not touch or read state on the List route", () => {
    window.history.replaceState(null, "", `${board}/sessions?scope=archived&q=list`);
    writeBoardBrowseHistory(historyScope, { searchQuery: "board only", status: "failed" });
    expect(window.location.search).toBe("?scope=archived&q=list");
    expect(readBoardBrowseHistory(historyScope)).toBeNull();
  });

  it("expires private state when leaving the document, including a cached document", () => {
    window.history.replaceState(null, "", board);
    writeBoardBrowseHistory(historyScope, { searchQuery: "board only", laneKey: "build" });
    window.dispatchEvent(new Event("pagehide"));
    expect(readBoardBrowseHistory(historyScope)).toEqual({
      laneKey: undefined,
      searchQuery: "",
      status: "all",
    });
  });
});
