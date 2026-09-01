import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadAuthenticatedWorkspaceContext: vi.fn(),
}));

vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocked.loadAuthenticatedWorkspaceContext,
}));

vi.mock("@/lib/storage/workspace-avatar", () => ({
  getWorkspaceAvatarUrl: (path: string | null) => (path ? `https://cdn.example.com/${path}` : null),
}));

import { loadWorkspaceLayoutContext } from "@/features/workspaces/workspace-layout-data";

const user = { email: "owner@example.com", id: "user-1" };
const workspace = {
  avatar_path: null,
  id: "workspace-1",
  name: "Northwind",
  slug: "northwind",
};

function buildSupabaseMock(
  onboardingRow: {
    current_step: string;
    status: string;
  } | null = {
    current_step: "github",
    status: "dismissed",
  },
  profileRow: { avatar_url: string | null } | null = { avatar_url: null },
) {
  return {
    from: vi.fn((table: string) => {
      if (table === "workspace_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: onboardingRow, error: null }),
            }),
          }),
        };
      }

      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: profileRow, error: null }),
            }),
          }),
        };
      }

      throw new Error(`unexpected table ${table}`);
    }),
  };
}

describe("loadWorkspaceLayoutContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns lightweight shell context without repository picker options", async () => {
    const supabase = buildSupabaseMock({
      current_step: "repository",
      status: "in_progress",
    });
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      supabase,
      user,
      workspace,
    });
    await expect(loadWorkspaceLayoutContext("member-access")).resolves.toEqual({
      onboarding: {
        currentStep: "repository",
        status: "in_progress",
      },
      supabase,
      user,
      viewerAvatarUrl: null,
      workspace,
      workspaceAvatarUrl: null,
    });
    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(supabase.from).toHaveBeenNthCalledWith(1, "workspace_onboarding");
    expect(supabase.from).toHaveBeenNthCalledWith(2, "profiles");
  });

  it("returns the signed-in user's profile photo from profiles", async () => {
    const supabase = buildSupabaseMock(
      {
        current_step: "github",
        status: "dismissed",
      },
      { avatar_url: "https://cdn.example.com/owner.png" },
    );
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      supabase,
      user,
      workspace,
    });
    await expect(loadWorkspaceLayoutContext("member-access")).resolves.toMatchObject({
      viewerAvatarUrl: "https://cdn.example.com/owner.png",
    });
  });

  it("treats a missing onboarding row as setup-required state", async () => {
    const supabase = buildSupabaseMock(null);
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      supabase,
      user,
      workspace,
    });
    await expect(loadWorkspaceLayoutContext("legacy-workspace")).resolves.toMatchObject({
      onboarding: {
        currentStep: "github",
        status: "not_started",
      },
    });
  });

  it("omits the default-repository segment from workspace layout timing", async () => {
    const supabase = buildSupabaseMock();
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({ supabase, user, workspace });
    vi.stubEnv("WALLIE_TIMING_LOGS", "1");
    const timingLog = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await loadWorkspaceLayoutContext("timed-workspace");

    const timingPayload = timingLog.mock.calls.find(
      (call) => call[0] === "[server-timing]",
    )?.[1] as { segments?: Array<{ name: string }> } | undefined;
    expect(timingPayload?.segments?.map((segment) => segment.name)).toEqual([
      "auth-workspace-context",
      "workspace-onboarding",
      "viewer-profile",
    ]);
    expect(timingPayload?.segments).not.toContainEqual(
      expect.objectContaining({ name: "default-session-repository" }),
    );
  });
});
