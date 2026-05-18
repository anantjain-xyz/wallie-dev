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

const user = { email: "owner@example.com", id: "user-1" };
const workspace = { id: "workspace-1", name: "Northwind", slug: "northwind" };

function buildSupabaseMock(
  onboardingRow: { current_step: string; status: string } | null = {
    current_step: "github",
    status: "dismissed",
  },
) {
  return {
    from: vi.fn((table: string) => {
      if (table !== "workspace_onboarding") {
        throw new Error(`unexpected table ${table}`);
      }

      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: onboardingRow, error: null }),
          }),
        }),
      };
    }),
  };
}

describe("loadWorkspaceLayoutContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated users to login with the workspace next path", async () => {
    const supabase = buildSupabaseMock();
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    await expect(loadWorkspaceLayoutContext("unauth-workspace")).rejects.toThrow(
      "redirect:/login?next=%2Fw%2Funauth-workspace",
    );
  });

  it("redirects to workspace onboarding when no workspace exists for the user", async () => {
    const supabase = buildSupabaseMock();
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(null);
    mocked.hasAnyWorkspaceForUser.mockResolvedValue(false);

    await expect(loadWorkspaceLayoutContext("missing-empty")).rejects.toThrow(
      "redirect:/onboarding/workspace",
    );
  });

  it("returns not found for a missing workspace when the user has another workspace", async () => {
    const supabase = buildSupabaseMock();
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(null);
    mocked.hasAnyWorkspaceForUser.mockResolvedValue(true);

    await expect(loadWorkspaceLayoutContext("missing-owned")).rejects.toThrow("not-found");
  });

  it("ensures the user profile and returns member workspace context", async () => {
    const supabase = buildSupabaseMock({ current_step: "repository", status: "in_progress" });
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(workspace);

    await expect(loadWorkspaceLayoutContext("member-access")).resolves.toEqual({
      onboarding: {
        currentStep: "repository",
        status: "in_progress",
      },
      supabase,
      user,
      workspace,
    });
    expect(mocked.ensureProfileForUser).toHaveBeenCalledWith(supabase, user);
  });

  it("treats a missing onboarding row as setup-required state", async () => {
    const supabase = buildSupabaseMock(null);
    mocked.createSupabaseServerClient.mockResolvedValue(supabase);
    mocked.getSupabaseUserOrNull.mockResolvedValue(user);
    mocked.getWorkspaceBySlugForUser.mockResolvedValue(workspace);

    await expect(loadWorkspaceLayoutContext("legacy-workspace")).resolves.toMatchObject({
      onboarding: {
        currentStep: "github",
        status: "not_started",
      },
    });
  });
});
