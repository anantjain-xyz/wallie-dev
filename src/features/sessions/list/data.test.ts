import { describe, expect, it } from "vitest";

import { parseSessionListQueryState } from "@/features/sessions/list/data";

describe("parseSessionListQueryState", () => {
  it("maps supported filters, stage, search, sort, and cursor from URL params", () => {
    expect(
      parseSessionListQueryState({
        cursor: "cursor-token",
        q: "  auth flow  ",
        scope: "has-pr",
        sort: "oldest",
        stage: "build",
      }),
    ).toEqual({
      cursor: "cursor-token",
      query: "  auth flow  ",
      scope: "has-pr",
      sort: "oldest",
      stageSlug: "build",
    });
  });

  it("uses the first value for repeated params and falls back from unknown scope/sort", () => {
    expect(
      parseSessionListQueryState({
        cursor: ["older", "newer"],
        q: ["linear-42", "ignored"],
        scope: "unknown",
        sort: "bogus",
        stage: ["plan", "land"],
      }),
    ).toEqual({
      cursor: "older",
      query: "linear-42",
      scope: "all",
      sort: "updated",
      stageSlug: "plan",
    });
  });

  it("defaults missing params without inventing a cursor", () => {
    expect(parseSessionListQueryState({})).toEqual({
      cursor: null,
      query: "",
      scope: "all",
      sort: "updated",
      stageSlug: null,
    });
  });
});
