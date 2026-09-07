import { describe, expect, it, vi } from "vitest";

import { loadSessionListPageData } from "@/features/sessions/list/data";

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
