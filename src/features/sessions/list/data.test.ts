import { describe, expect, it, vi } from "vitest";

import { parseSessionListQueryState, loadSessionListPageData } from "@/features/sessions/list/data";

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

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/features/workspaces/workspace-layout-data", () => ({
  loadWorkspaceLayoutContext: async () => ({
    workspace: { id: "workspace", name: "Acme", slug: "acme" },
    onboarding: null,
    supabase: { rpc: mocks.rpc },
  }),
}));

describe("list run-status payload compatibility", () => {
  it("normalizes older payloads and preserves latest run states", async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        sessions: [
          { id: "old", number: 1 },
          { id: "failed", number: 2, latestRunStatus: "error" },
          { id: "retry", number: 3, latestRunStatus: "running" },
        ],
      },
      error: null,
    });
    const data = await loadSessionListPageData("acme", {});
    expect(data.sessions.map((session) => session.latestRunStatus)).toEqual([
      null,
      "error",
      "running",
    ]);
  });
});
