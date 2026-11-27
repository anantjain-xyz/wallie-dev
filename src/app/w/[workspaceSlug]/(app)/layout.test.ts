import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  AppShell: vi.fn(() => null),
  loadWorkspaceFactoryOptions: vi.fn(),
  loadWorkspaceLayoutContext: vi.fn(),
  loadWorkspaceSwitcherOptions: vi.fn(),
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

vi.mock("@/components/app-shell/workspace-switcher-data", () => ({
  loadWorkspaceSwitcherOptions: mocked.loadWorkspaceSwitcherOptions,
}));

import WorkspaceAppLayout from "./layout";

describe("workspace app route group layout", () => {
  it.each([
    {
      role: "owner",
      isDefault: true,
      status: "active",
      canManage: true,
      managesFactory: true,
    },
    {
      role: "member",
      isDefault: false,
      status: "active",
      canManage: false,
      managesFactory: false,
    },
    {
      role: "member",
      isDefault: false,
      status: "active",
      canManage: false,
      managesFactory: true,
    },
    {
      role: "admin",
      isDefault: true,
      status: "archived",
      canManage: true,
      managesFactory: true,
    },
  ])(
    "supplies authorized factory options and workspace capabilities for $role/$status",
    async ({ role, isDefault, status, canManage, managesFactory }) => {
      const workspace = { id: "workspace-1", name: "Northwind", slug: "northwind" };
      const onboarding = { currentStep: "repository", status: "in_progress" };
      const factories = [
        { id: "factory-1", name: "Northwind", isDefault, status, canManage: managesFactory },
      ];
      mocked.loadWorkspaceFactoryOptions.mockResolvedValue(factories);
      const workspaceOptions = [{ name: "Tailspin", slug: "tailspin" }];
      mocked.loadWorkspaceSwitcherOptions.mockResolvedValue(workspaceOptions);
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
        factories: typeof factories;
        children: string;
        onboarding: typeof onboarding;
        viewerAvatarUrl: string | null;
        viewerEmail: string;
        viewerId: string;
        workspace: typeof workspace;
        workspaceAvatarUrl: string | null;
        workspaceOptions: typeof workspaceOptions;
      }>;

      expect(element.type).toBe(mocked.AppShell);
      expect(element.props).toMatchObject({
        canManageFactoryDefinition: canManage,
        factories,
        children: "app-page",
        onboarding,
        viewerAvatarUrl: "https://cdn.example.com/owner.png",
        viewerEmail: "owner@example.com",
        viewerId: "user-1",
        workspace,
        workspaceAvatarUrl: "https://cdn.example.com/avatar.png",
        workspaceOptions,
      });
      expect(element.props).not.toHaveProperty("creationFactory");
    },
  );
});
