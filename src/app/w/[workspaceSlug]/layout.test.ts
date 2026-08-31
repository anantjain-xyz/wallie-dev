import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadAuthenticatedWorkspaceContext: vi.fn(),
}));

vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocked.loadAuthenticatedWorkspaceContext,
}));

import WorkspaceLayout from "./layout";

describe("workspace root layout", () => {
  it("keeps the root route as the access boundary without rendering the app shell", async () => {
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      user: { email: "owner@example.com" },
      workspace: { id: "workspace-1", name: "Northwind", slug: "northwind" },
    });

    await expect(
      WorkspaceLayout({
        children: "onboarding-screen",
        params: Promise.resolve({ workspaceSlug: "northwind" }),
      }),
    ).resolves.toBe("onboarding-screen");
    expect(mocked.loadAuthenticatedWorkspaceContext).toHaveBeenCalledWith("northwind");
  });
});
