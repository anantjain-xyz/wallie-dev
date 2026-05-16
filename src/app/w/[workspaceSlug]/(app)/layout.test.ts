import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  AppShell: vi.fn(() => null),
  loadWorkspaceLayoutContext: vi.fn(),
}));

vi.mock("@/components/app-shell/app-shell", () => ({
  AppShell: mocked.AppShell,
}));

vi.mock("@/features/workspaces/workspace-layout-data", () => ({
  loadWorkspaceLayoutContext: mocked.loadWorkspaceLayoutContext,
}));

import WorkspaceAppLayout from "./layout";

describe("workspace app route group layout", () => {
  it("wraps workspace app pages in the normal app shell", async () => {
    const workspace = { id: "workspace-1", name: "Northwind", slug: "northwind" };
    mocked.loadWorkspaceLayoutContext.mockResolvedValue({
      user: { email: "owner@example.com" },
      workspace,
    });

    const element = (await WorkspaceAppLayout({
      children: "app-page",
      params: Promise.resolve({ workspaceSlug: "northwind" }),
    })) as ReactElement<{
      children: string;
      viewerEmail: string;
      workspace: typeof workspace;
    }>;

    expect(element.type).toBe(mocked.AppShell);
    expect(element.props).toMatchObject({
      children: "app-page",
      viewerEmail: "owner@example.com",
      workspace,
    });
  });
});
