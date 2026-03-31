import { describe, expect, it } from "vitest";

import {
  mergeIssueListPreferences,
  parseIssueListQueryState,
  readIssueListPreferences,
  serializeIssueListQueryState,
} from "@/features/issues/list/query-state";

describe("issue list query state", () => {
  it("parses comma-separated and repeated filter params", () => {
    const state = parseIssueListQueryState(
      new URLSearchParams(
        "status=todo,in_progress&status=done&priority=high&estimate=null,3&query=  agent  ",
      ),
    );

    expect(state).toEqual({
      direction: "desc",
      estimates: [null, 3],
      priorities: ["high"],
      query: "agent",
      sort: "updated",
      statuses: ["todo", "in_progress", "done"],
    });
  });

  it("accepts the legacy orderBy aliases and member preference fallback", () => {
    const state = parseIssueListQueryState(
      new URLSearchParams("orderBy=priority&orderDirection=asc"),
      {
        direction: "desc",
        sort: "status",
      },
    );

    expect(state.sort).toBe("priority");
    expect(state.direction).toBe("asc");
  });

  it("reads and merges issue list preferences from member JSON", () => {
    expect(
      readIssueListPreferences({
        issues: {
          direction: "asc",
          sort: "priority",
        },
        onboarding: {
          complete: true,
        },
      }),
    ).toEqual({
      direction: "asc",
      sort: "priority",
    });

    expect(
      mergeIssueListPreferences(
        {
          issues: {
            direction: "desc",
          },
          onboarding: {
            complete: true,
          },
        },
        {
          direction: "asc",
          sort: "status",
        },
      ),
    ).toEqual({
      issues: {
        direction: "asc",
        sort: "status",
      },
      onboarding: {
        complete: true,
      },
    });
  });

  it("serializes non-default search state into stable params", () => {
    const params = serializeIssueListQueryState({
      direction: "asc",
      estimates: [null, 1, 3],
      priorities: ["medium"],
      query: "design docs",
      sort: "priority",
      statuses: ["todo", "in_progress"],
    });

    expect(params.toString()).toBe(
      "query=design+docs&status=todo%2Cin_progress&priority=medium&estimate=null%2C1%2C3&sort=priority&direction=asc",
    );
  });
});
