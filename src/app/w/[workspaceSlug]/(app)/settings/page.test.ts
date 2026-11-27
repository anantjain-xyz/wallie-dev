import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  SettingsServerShell: vi.fn(() => null),
  loadWorkspaceFactoryOptions: vi.fn(),
  loadSettingsPageData: vi.fn(),
}));

vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocked.loadWorkspaceFactoryOptions,
}));
vi.mock("@/features/settings/data", () => ({
  loadSettingsPageData: mocked.loadSettingsPageData,
}));

vi.mock("@/features/settings/settings-server-shell", () => ({
  SettingsServerShell: mocked.SettingsServerShell,
}));

import SettingsPage from "./page";

describe("SettingsPage", () => {
  it("awaits only above-fold data and passes slower section promises through", async () => {
    const initialData = {
      canManage: false,
      currentMember: { id: "member-1", role: "member" },
      github: { installation: null, repositories: [] },
      workspace: { id: "workspace-1", name: "Northwind", slug: "northwind" },
    };
    const setupData = new Promise<never>(() => undefined);
    const usage = new Promise<never>(() => undefined);
    const workspaceInvitations = new Promise<never>(() => undefined);
    const factories = new Promise<never>(() => undefined);
    mocked.loadWorkspaceFactoryOptions.mockReturnValue(factories);
    mocked.loadSettingsPageData.mockResolvedValue({
      initialData: Promise.resolve(initialData),
      setupData,
      usage,
      workspaceInvitations,
    });

    const element = (await SettingsPage({
      params: Promise.resolve({ workspaceSlug: "northwind" }),
      searchParams: Promise.resolve({
        category: "workspace",
        github: "connected",
        afterOAuthGrant: "56800000-0000-4000-8000-000000000001",
        oauthView: "history",
        factory: "56800000-0000-4000-8000-000000000002",
      }),
    })) as ReactElement;

    expect(mocked.loadSettingsPageData).toHaveBeenCalledWith("northwind", "workspace");

    expect(element.type).toBe(mocked.SettingsServerShell);
    expect(element.props).toMatchObject({
      category: "workspace",
      initialData,
      searchState: { githubStatus: "connected" },
      personalConnections: undefined,
      personalProviderAccess: undefined,
      setupData,
      usage,
      workspaceFactories: {
        props: {
          canManage: false,
          factories,
          requestedSetup: "56800000-0000-4000-8000-000000000002",
          workspace: initialData.workspace,
        },
      },
      workspaceInvitations,
      workspaceOAuthClients: undefined,
    });
  });

  it("streams the active member's personal sections without a workspace directory or OAuth administration", async () => {
    const initialData = {
      canManage: true,
      currentMember: { id: "member-1", role: "owner" },
      github: { installation: null, repositories: [] },
      workspace: { id: "workspace-1", name: "Northwind", slug: "northwind" },
    };
    const workspaceProfile = new Promise<never>(() => undefined);
    const personalProviderContext = new Promise<never>(() => undefined);
    const pending = new Promise<never>(() => undefined);
    mocked.loadSettingsPageData.mockResolvedValue({
      initialData: Promise.resolve(initialData),
      personalProviderContext,
      setupData: pending,
      usage: pending,
      workspaceInvitations: pending,
      workspaceProfile,
    });

    const element = (await SettingsPage({
      params: Promise.resolve({ workspaceSlug: "northwind" }),
      searchParams: Promise.resolve({
        category: "personal",
        afterOAuthGrant: "56800000-0000-4000-8000-000000000001",
        oauthView: "history",
        provider: "cursor",
      }),
    })) as ReactElement;

    expect(mocked.loadSettingsPageData).toHaveBeenLastCalledWith("northwind", "personal");
    expect(element.type).toBe(mocked.SettingsServerShell);
    expect(element.props).toMatchObject({
      category: "personal",
      personalConnections: {
        props: {
          afterOAuthGrant: "56800000-0000-4000-8000-000000000001",
          history: true,
          workspaceSlug: "northwind",
        },
      },
      personalProviderAccess: {
        props: {
          canManageWorkspace: true,
          context: personalProviderContext,
          requestedProvider: "cursor",
          workspaceId: initialData.workspace.id,
          workspaceSlug: "northwind",
        },
      },
      workspaceFactories: undefined,
      workspaceOAuthClients: undefined,
      workspaceProfile,
    });
  });
});
