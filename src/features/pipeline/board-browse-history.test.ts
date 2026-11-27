// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import {
  parseBoardStatus,
  readBoardBrowseHistory,
  writeBoardBrowseHistory,
} from "@/features/pipeline/board-browse-history";

const board = "/w/wallie";

afterEach(() => window.history.replaceState(null, "", "/"));

describe("board browse history", () => {
  it("accepts one supported status and rejects a repeated or unrelated value", () => {
    expect(parseBoardStatus("awaiting_review")).toBe("awaiting_review");
    expect(parseBoardStatus("failed")).toBe("failed");
    expect(parseBoardStatus(["failed", "failed"])).toBe("all");
    expect(parseBoardStatus("archived")).toBe("all");
  });

  it("keeps only shareable status in the URL and makes the search factory-local", () => {
    window.history.replaceState(null, "", `${board}?factory=all#anchor`);
    writeBoardBrowseHistory(board, "all", { searchQuery: "board only", status: "failed" });
    writeBoardBrowseHistory(board, "all", { laneKey: "build" });

    expect(window.location.search).toBe("?factory=all&status=failed");
    expect(window.location.hash).toBe("#anchor");
    expect(readBoardBrowseHistory(board, "all")).toEqual({
      laneKey: "build",
      searchQuery: "board only",
      status: "failed",
    });
    expect(readBoardBrowseHistory(board, "different-factory")?.searchQuery).toBe("");

    writeBoardBrowseHistory(board, "all", { searchQuery: "", status: "all" });
    expect(window.location.search).toBe("?factory=all");
    expect(readBoardBrowseHistory(board, "all")).toEqual({
      laneKey: "build",
      searchQuery: "",
      status: "all",
    });
  });

  it("does not touch or read state on the List route", () => {
    window.history.replaceState(null, "", `${board}/sessions?scope=archived&q=list`);
    writeBoardBrowseHistory(board, "all", { searchQuery: "board only", status: "failed" });
    expect(window.location.search).toBe("?scope=archived&q=list");
    expect(readBoardBrowseHistory(board, "all")).toBeNull();
  });
});
