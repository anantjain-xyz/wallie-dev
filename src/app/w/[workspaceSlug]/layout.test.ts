import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadWorkspaceLayoutContext: vi.fn(),
}));

vi.mock("@/features/workspaces/workspace-layout-data", () => ({
  loadWorkspaceLayoutContext: mocked.loadWorkspaceLayoutContext,
}));

import WorkspaceLayout from "./layout";

describe("workspace root layout", () => {
  it("keeps the root route as the access boundary without rendering the app shell", async () => {
    mocked.loadWorkspaceLayoutContext.mockResolvedValue({
      user: { email: "owner@example.com" },
      workspace: { id: "workspace-1", name: "Northwind", slug: "northwind" },
    });

    await expect(
      WorkspaceLayout({
        children: "onboarding-screen",
        params: Promise.resolve({ workspaceSlug: "northwind" }),
      }),
    ).resolves.toBe("onboarding-screen");
    expect(mocked.loadWorkspaceLayoutContext).toHaveBeenCalledWith("northwind");
  });
});
