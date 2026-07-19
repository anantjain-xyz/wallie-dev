import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
  SettingsServerShell: vi.fn(() => null),
  loadSettingsPageData: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: mocked.notFound,
  redirect: mocked.redirect,
}));

vi.mock("@/features/settings/data", () => ({
  loadSettingsPageData: mocked.loadSettingsPageData,
}));

vi.mock("@/features/settings/settings-server-shell", () => ({
  SettingsServerShell: mocked.SettingsServerShell,
}));

import SettingsIndexPage from "./page";
import SettingsCategoryPage, { generateMetadata } from "./[category]/page";

describe("SettingsIndexPage", () => {
  beforeEach(() => {
    mocked.redirect.mockClear();
  });

  it("redirects /settings to General by default", async () => {
    await expect(
      SettingsIndexPage({
        params: Promise.resolve({ workspaceSlug: "northwind" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("redirect:/w/northwind/settings/general");
  });

  it("maps legacy category query params to owning routes", async () => {
    await expect(
      SettingsIndexPage({
        params: Promise.resolve({ workspaceSlug: "northwind" }),
        searchParams: Promise.resolve({ category: "workspace" }),
      }),
    ).rejects.toThrow("redirect:/w/northwind/settings/general");

    await expect(
      SettingsIndexPage({
        params: Promise.resolve({ workspaceSlug: "northwind" }),
        searchParams: Promise.resolve({ category: "integrations", github: "connected" }),
      }),
    ).rejects.toThrow("redirect:/w/northwind/settings/integrations?github=connected");
  });

  it("routes OAuth flash params to their owning category", async () => {
    await expect(
      SettingsIndexPage({
        params: Promise.resolve({ workspaceSlug: "northwind" }),
        searchParams: Promise.resolve({ github: "connected" }),
      }),
    ).rejects.toThrow("redirect:/w/northwind/settings/integrations?github=connected");

    await expect(
      SettingsIndexPage({
        params: Promise.resolve({ workspaceSlug: "northwind" }),
        searchParams: Promise.resolve({ codex_connect: "connected" }),
      }),
    ).rejects.toThrow("redirect:/w/northwind/settings/agent-execution?codex_connect=connected");
  });
});

describe("SettingsCategoryPage", () => {
  beforeEach(() => {
    mocked.loadSettingsPageData.mockReset();
    mocked.SettingsServerShell.mockClear();
    mocked.notFound.mockClear();
  });

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

    const element = (await SettingsCategoryPage({
      params: Promise.resolve({ category: "members", workspaceSlug: "northwind" }),
      searchParams: Promise.resolve({ github: "connected" }),
    })) as ReactElement;

    expect(mocked.loadSettingsPageData).toHaveBeenCalledWith("northwind", "members");
    expect(element.type).toBe(mocked.SettingsServerShell);
    expect(element.props).toMatchObject({
      category: "members",
      initialData,
      searchState: { codexStatus: null, githubStatus: "connected" },
      setupData,
      usage,
      workspaceInvitations,
    });
  });

  it("returns notFound for unknown categories", async () => {
    await expect(
      SettingsCategoryPage({
        params: Promise.resolve({ category: "unknown", workspaceSlug: "northwind" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("not-found");
  });

  it("sets an accurate document title per category", async () => {
    await expect(
      generateMetadata({
        params: Promise.resolve({ category: "agent-execution", workspaceSlug: "northwind" }),
      }),
    ).resolves.toEqual({ title: "Agent execution" });
  });
});
