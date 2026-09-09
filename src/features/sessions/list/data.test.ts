import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ getCookie: vi.fn(), rpc: vi.fn() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocked.getCookie }),
}));

vi.mock("@/features/workspaces/workspace-layout-data", () => ({
  loadWorkspaceLayoutContext: async (slug: string) => ({
    workspace: { slug },
    onboarding: null,
    supabase: { rpc: mocked.rpc },
  }),
}));

import { loadSessionListPageData } from "@/features/sessions/list/data";
import { sessionListPreferencesCookieName } from "@/features/sessions/list/sessions-list-preferences";

describe("sessions list server filter restoration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getCookie.mockReturnValue({
      value: encodeURIComponent(
        JSON.stringify({ scope: "all", sort: "oldest", stageSlug: "build" }),
      ),
    });
    mocked.rpc.mockResolvedValue({ data: { sessions: [] }, error: null });
  });

  it("applies saved filters to the first and only list query", async () => {
    const data = await loadSessionListPageData("acme", { q: "auth", create: "1" });

    expect(mocked.getCookie).toHaveBeenCalledWith(sessionListPreferencesCookieName("acme"));
    expect(mocked.rpc).toHaveBeenCalledExactlyOnceWith(
      "get_session_list_page",
      expect.objectContaining({
        session_scope: "all",
        sort_key: "oldest",
        stage_filter_slug: "build",
        search_query: "auth",
      }),
    );
    expect(data.queryState).toEqual({
      cursor: null,
      query: "auth",
      scope: "all",
      sort: "oldest",
      stageSlug: "build",
    });
  });

  it.each([
    { scope: "active" },
    { scope: "invalid" },
    { scope: "" },
    { stage: "" },
    { sort: "updated" },
    { cursor: "page-2" },
    { cursor: "" },
  ])("respects explicit URL filters and pagination: %j", async (search) => {
    const data = await loadSessionListPageData("acme", search);
    expect(data.queryState.scope).toBe("active");
    expect(data.queryState.sort).toBe("updated");
    expect(mocked.rpc).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, { value: "%invalid" }])(
    "uses defaults for a missing or malformed cookie",
    async (cookie) => {
      mocked.getCookie.mockReturnValue(cookie);
      const data = await loadSessionListPageData("acme", {});
      expect(data.queryState).toEqual({
        cursor: null,
        query: "",
        scope: "active",
        sort: "updated",
        stageSlug: null,
      });
      expect(mocked.rpc).toHaveBeenCalledTimes(1);
    },
  );
});

describe("list run-status payload compatibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getCookie.mockReturnValue(undefined);
  });

  it("normalizes older payloads and preserves latest run states", async () => {
    mocked.rpc.mockResolvedValue({
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

  it("defaults scope counts to zero when the payload omits them", async () => {
    mocked.rpc.mockResolvedValue({ data: { sessions: [] }, error: null });
    const withoutFacets = await loadSessionListPageData("acme", {});
    expect(withoutFacets.scopeFacets).toEqual({ active: 0, all: 0, archived: 0 });

    mocked.rpc.mockResolvedValue({
      data: { scopeFacets: { active: 3, all: 5, archived: 2 }, sessions: [] },
      error: null,
    });
    const withFacets = await loadSessionListPageData("acme", {});
    expect(withFacets.scopeFacets).toEqual({ active: 3, all: 5, archived: 2 });
  });
});
