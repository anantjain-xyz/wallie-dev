import { describe, expect, it, vi } from "vitest";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { loadWorkspaceSwitcherOptions } from "./workspace-switcher-data";

vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: vi.fn(),
}));

describe("workspace switcher options", () => {
  it("queries the signed-in viewer’s own active human memberships and returns display data only", async () => {
    const rows = [
      { name: "Northwind", slug: "northwind", membership: [{ id: "member-a" }] },
      { name: "Tailspin", slug: "tailspin", membership: [{ id: "member-b" }] },
    ];
    const query = { select: vi.fn(), eq: vi.fn(), order: vi.fn() };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockReturnValueOnce(query).mockResolvedValueOnce({ data: rows, error: null });
    const from = vi.fn(() => query);
    vi.mocked(loadAuthenticatedWorkspaceContext).mockResolvedValue({
      supabase: { from },
      user: { id: "viewer" },
    } as unknown as Awaited<ReturnType<typeof loadAuthenticatedWorkspaceContext>>);

    await expect(loadWorkspaceSwitcherOptions("northwind")).resolves.toEqual([
      { name: "Northwind", slug: "northwind" },
      { name: "Tailspin", slug: "tailspin" },
    ]);
    expect(loadAuthenticatedWorkspaceContext).toHaveBeenCalledWith("northwind");
    expect(from).toHaveBeenCalledWith("workspaces");
    expect(query.select).toHaveBeenCalledWith("name, slug, membership:workspace_members!inner(id)");
    expect(query.eq.mock.calls).toEqual([
      ["membership.user_id", "viewer"],
      ["membership.kind", "human"],
      ["membership.is_active", true],
    ]);
  });
});
