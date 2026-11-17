import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  AppShell: vi.fn(() => null),
  loadWorkspaceFactoryOptions: vi.fn(),
  loadWorkspaceLayoutContext: vi.fn(),
}));

vi.mock("@/components/app-shell/app-shell", () => ({
  AppShell: mocked.AppShell,
}));

vi.mock("@/features/workspaces/workspace-layout-data", () => ({
  loadWorkspaceLayoutContext: mocked.loadWorkspaceLayoutContext,
}));

vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocked.loadWorkspaceFactoryOptions,
}));

import WorkspaceAppLayout from "./layout";

describe("workspace app route group layout", () => {
  it.each([
    { role: "owner", isDefault: true, status: "active", canManage: true, canStart: true },
    { role: "member", isDefault: false, status: "active", canManage: false, canStart: false },
    { role: "admin", isDefault: true, status: "archived", canManage: true, canStart: false },
  ])(
    "wraps workspace pages with the right factory actions for $role/$status",
    async ({ role, isDefault, status, canManage, canStart }) => {
      const workspace = { id: "workspace-1", name: "Northwind", slug: "northwind" };
      const onboarding = { currentStep: "repository", status: "in_progress" };
      const factories = [{ id: "factory-1", name: "Northwind", isDefault, status }];
      mocked.loadWorkspaceFactoryOptions.mockResolvedValue(factories);
      mocked.loadWorkspaceLayoutContext.mockResolvedValue({
        currentMember: { kind: "human", is_active: true, role },
        onboarding,
        user: { email: "owner@example.com", id: "user-1" },
        viewerAvatarUrl: "https://cdn.example.com/owner.png",
        workspace,
        workspaceAvatarUrl: "https://cdn.example.com/avatar.png",
      });

      const element = (await WorkspaceAppLayout({
        children: "app-page",
        params: Promise.resolve({ workspaceSlug: "northwind" }),
      })) as ReactElement<{
        canManageFactoryDefinition: boolean;
        canStartDefaultFactorySession: boolean;
        children: string;
        factorySelector: ReactElement;
        onboarding: typeof onboarding;
        viewerAvatarUrl: string | null;
        viewerEmail: string;
        viewerId: string;
        workspace: typeof workspace;
        workspaceAvatarUrl: string | null;
      }>;

      expect(element.type).toBe(mocked.AppShell);
      expect(element.props).toMatchObject({
        canManageFactoryDefinition: canManage,
        canStartDefaultFactorySession: canStart,
        children: "app-page",
        factorySelector: { props: { factories, workspaceSlug: "northwind" } },
        onboarding,
        viewerAvatarUrl: "https://cdn.example.com/owner.png",
        viewerEmail: "owner@example.com",
        viewerId: "user-1",
        workspace,
        workspaceAvatarUrl: "https://cdn.example.com/avatar.png",
      });
    },
  );
});
