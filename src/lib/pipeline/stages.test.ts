import { describe, expect, it } from "vitest";

import { loadSessionPullRequestContext } from "./stages";

describe("loadSessionPullRequestContext", () => {
  it("selects by immutable creation chronology instead of webhook update time", async () => {
    const orders: Array<{ column: string; ascending: boolean }> = [];
    const query = {
      eq: () => query,
      limit: () => query,
      maybeSingle: async () => ({
        data: {
          pull_request_number: 43,
          pull_request_url: "https://github.com/acme/app/pull/43",
        },
        error: null,
      }),
      order: (column: string, options: { ascending: boolean }) => {
        orders.push({ column, ascending: options.ascending });
        return query;
      },
    };
    const admin = {
      from: () => ({ select: () => query }),
    };

    await expect(loadSessionPullRequestContext(admin as never, "session-1")).resolves.toEqual({
      number: 43,
      url: "https://github.com/acme/app/pull/43",
    });
    expect(orders).toEqual([
      { ascending: false, column: "created_at" },
      { ascending: false, column: "id" },
    ]);
  });
});
