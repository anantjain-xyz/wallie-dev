import { describe, expect, it } from "vitest";

import {
  areDefaultSessionListFilters,
  parseSessionListQueryState,
  parseSessionListScope,
  parseSessionListSort,
  sessionListSearchHasStickyParams,
} from "@/features/sessions/list/sessions-list-query-state";

describe("parseSessionListQueryState", () => {
  it("maps supported filters, stage, search, sort, and cursor from URL params", () => {
    expect(
      parseSessionListQueryState({
        cursor: "cursor-token",
        q: "  auth flow  ",
        scope: "archived",
        sort: "oldest",
        stage: "build",
      }),
    ).toEqual({
      cursor: "cursor-token",
      query: "  auth flow  ",
      scope: "archived",
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
      scope: "active",
      sort: "updated",
      stageSlug: "plan",
    });
  });

  it("defaults missing params without inventing a cursor", () => {
    expect(parseSessionListQueryState({})).toEqual({
      cursor: null,
      query: "",
      scope: "active",
      sort: "updated",
      stageSlug: null,
    });
  });

  it.each(["active", "archived", "all"] as const)("preserves the explicit %s scope", (scope) => {
    expect(parseSessionListQueryState({ scope }).scope).toBe(scope);
  });
});

describe("session list sticky query helpers", () => {
  it("treats unknown scope and sort as the URL defaults", () => {
    expect(parseSessionListScope("nope")).toBe("active");
    expect(parseSessionListSort("nope")).toBe("updated");
    expect(parseSessionListSort("updated")).toBe("updated");
  });

  it("detects sticky keys even when they hold default values", () => {
    expect(sessionListSearchHasStickyParams(new URLSearchParams())).toBe(false);
    expect(sessionListSearchHasStickyParams(new URLSearchParams("q=auth"))).toBe(false);
    expect(sessionListSearchHasStickyParams(new URLSearchParams("scope=active"))).toBe(true);
    expect(sessionListSearchHasStickyParams(new URLSearchParams("stage=build"))).toBe(true);
    expect(sessionListSearchHasStickyParams(new URLSearchParams("sort=updated"))).toBe(true);
  });

  it("treats missing or empty stage as the default filter set", () => {
    expect(
      areDefaultSessionListFilters({ scope: "active", sort: "updated", stageSlug: null }),
    ).toBe(true);
    expect(areDefaultSessionListFilters({ scope: "active", sort: "updated", stageSlug: "" })).toBe(
      true,
    );
    expect(areDefaultSessionListFilters({ scope: "all", sort: "updated", stageSlug: null })).toBe(
      false,
    );
  });
});
