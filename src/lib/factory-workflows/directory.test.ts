import { describe, expect, it } from "vitest";

import { parseWorkflowDirectoryQuery } from "./directory";

const after = "abcd0000-0000-4000-8000-000000000012";
const literalSearch = "Édit %_🚀";

describe("workflow directory query", () => {
  it("keeps literal Unicode search and normalizes the valid cursor", () => {
    expect(
      parseWorkflowDirectoryQuery({ q: `  ${literalSearch} `, after: after.toUpperCase() }),
    ).toEqual({ q: literalSearch, after, needsReset: false });
  });

  it.each([["bad-cursor"], [[after, after]]])(
    "keeps valid search when resetting cursor %j",
    (cursor) => {
      expect(parseWorkflowDirectoryQuery({ q: ` ${literalSearch} `, after: cursor })).toEqual({
        q: literalSearch,
        after: undefined,
        needsReset: true,
      });
    },
  );

  it.each([[["one", "two"]], ["a".repeat(121)], ["before\0after"], ["\ud800"], ["\udfff"]])(
    "drops invalid search %j and its cursor",
    (q) => {
      expect(parseWorkflowDirectoryQuery({ q, after })).toEqual({
        q: undefined,
        after: undefined,
        needsReset: true,
      });
    },
  );

  it("accepts a first page without query parameters", () => {
    expect(parseWorkflowDirectoryQuery({})).toEqual({
      q: undefined,
      after: undefined,
      needsReset: false,
    });
  });
});
