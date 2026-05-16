import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  getWorkspaceBySlugForUser: vi.fn(),
  hasAnyWorkspaceForUser: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("not-found");
  }),
  redirect: vi.fn((path: string) => {
    throw new Error(`redirect:${path}`);
  }),
}));

vi.mock("next/navigation", () => ({
  notFound: mocked.notFound,
  redirect: mocked.redirect,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/auth", () => ({
  ensureProfileForUser: mocked.ensureProfileForUser,
  getWorkspaceBySlugForUser: mocked.getWorkspaceBySlugForUser,
  hasAnyWorkspaceForUser: mocked.hasAnyWorkspaceForUser,
  workspaceLoginRedirectPath: (workspaceSlug: string) => `/w/${workspaceSlug}`,
}));

import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";

const supabase = { from: vi.fn() };
const user = { email: "owner@example.com", id: "user-1" };
const workspace = { id: "workspace-1", name: "Northwind", slug: "northwind" };

describe("loadWorkspaceLayoutContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to login with the workspace next path", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    await expect(loadWorkspaceLayoutContext("unauth-workspace")).rejects.toThrow(
      "redirect:/login?next=%2Fw%2Funauth-workspace",
    );
  });

  it("redirects to workspace onboarding when no workspace exists for the user", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(null);
    mocked.hasAnyWorkspaceForUser.mockResolvedValue(false);

    await expect(loadWorkspaceLayoutContext("missing-empty")).rejects.toThrow(
      "redirect:/onboarding/workspace",
    );
  });

  it("returns not found for a missing workspace when the user has another workspace", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(null);
    mocked.hasAnyWorkspaceForUser.mockResolvedValue(true);

    await expect(loadWorkspaceLayoutContext("missing-owned")).rejects.toThrow("not-found");
  });

  it("ensures the user profile and returns member workspace context", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(workspace);

    await expect(loadWorkspaceLayoutContext("member-access")).resolves.toEqual({
      supabase,
      user,
      workspace,
    });
    expect(mocked.ensureProfileForUser).toHaveBeenCalledWith(supabase, user);
  });
});
