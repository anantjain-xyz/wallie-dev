import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  SettingsServerShell: vi.fn(() => null),
  loadSettingsPageData: vi.fn(),
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
    mocked.loadSettingsPageData.mockResolvedValue({
      initialData: Promise.resolve(initialData),
      setupData,
      usage,
      workspaceInvitations,
    });

    const element = (await SettingsPage({
      params: Promise.resolve({ workspaceSlug: "northwind" }),
      searchParams: Promise.resolve({ category: "workspace", github: "connected" }),
    })) as ReactElement;

    expect(element.type).toBe(mocked.SettingsServerShell);
    expect(element.props).toMatchObject({
      category: "workspace",
      initialData,
      searchState: { codexStatus: null, githubStatus: "connected" },
      setupData,
      usage,
      workspaceInvitations,
    });
  });
});
