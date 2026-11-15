import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadWorkspaceLayoutContext: vi.fn(),
  loadWorkspaceRunCatalogPage: vi.fn(),
  RunCatalogCursorError: class extends Error {},
  RunCatalogWorkspaceUnavailableError: class extends Error {},
}));
vi.mock("@/features/workspaces/workspace-layout-data", () => ({
  loadWorkspaceLayoutContext: mocked.loadWorkspaceLayoutContext,
}));
vi.mock("@/features/wallie/run-catalog", () => ({
  loadWorkspaceRunCatalogPage: mocked.loadWorkspaceRunCatalogPage,
  RunCatalogCursorError: mocked.RunCatalogCursorError,
  RunCatalogWorkspaceUnavailableError: mocked.RunCatalogWorkspaceUnavailableError,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { loadRunsListData } from "@/features/wallie/runs-list-data";

const supabase = {};
beforeEach(() => {
  vi.resetAllMocks();
  mocked.loadWorkspaceLayoutContext.mockResolvedValue({
    supabase,
    workspace: { id: "authorized-workspace", slug: "canonical" },
  });
});

describe("Runs page data", () => {
  it("reuses the catalog owner with the authenticated canonical workspace and validated query", async () => {
    const page = { runs: [], nextCursor: null };
    mocked.loadWorkspaceRunCatalogPage.mockResolvedValue(page);
    const data = await loadRunsListData("requested", {
      status: "error",
      provider: "codex",
      limit: "20",
    });
    expect(mocked.loadWorkspaceRunCatalogPage).toHaveBeenCalledExactlyOnceWith({
      supabase,
      workspaceId: "authorized-workspace",
      workspaceSlug: "canonical",
      query: { status: "error", provider: "codex", limit: 20 },
    });
    expect(data.state).toEqual({ kind: "ready", page });
  });

  it("does not fetch a catalog for invalid filters", async () => {
    const data = await loadRunsListData("requested", { provider: "invalid" });
    expect(data.state).toEqual({ kind: "invalid-query" });
    expect(mocked.loadWorkspaceRunCatalogPage).not.toHaveBeenCalled();
  });

  it("keeps an invalid cursor distinct from an empty result and preserves valid filters", async () => {
    mocked.loadWorkspaceRunCatalogPage.mockRejectedValue(new mocked.RunCatalogCursorError());
    const data = await loadRunsListData("requested", { cursor: "stale", status: "error" });
    expect(data).toMatchObject({
      query: { cursor: "stale", status: "error" },
      state: { kind: "invalid-cursor" },
    });
  });

  it("does not render stale rows after workspace access is revoked", async () => {
    mocked.loadWorkspaceRunCatalogPage.mockRejectedValue(
      new mocked.RunCatalogWorkspaceUnavailableError(),
    );
    await expect(loadRunsListData("requested", {})).rejects.toThrow("NOT_FOUND");
  });

  it("returns a recoverable error without internal database details", async () => {
    mocked.loadWorkspaceRunCatalogPage.mockRejectedValue(new Error("private connection details"));
    const data = await loadRunsListData("requested", {});
    expect(data.state).toEqual({ kind: "error" });
    expect(JSON.stringify(data)).not.toContain("private connection details");
  });
});
