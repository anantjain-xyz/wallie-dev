import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadAuthenticatedWorkspaceContext: vi.fn(),
  loadDefaultSessionRepositoryId: vi.fn(),
}));

vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocked.loadAuthenticatedWorkspaceContext,
}));

vi.mock("@/features/sessions/repository-options", () => ({
  loadDefaultSessionRepositoryId: mocked.loadDefaultSessionRepositoryId,
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
    selected_github_repository_id?: string | null;
    status: string;
  } | null = {
    current_step: "github",
    selected_github_repository_id: null,
    status: "dismissed",
  },
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

      throw new Error(`unexpected table ${table}`);
    }),
  };
}

describe("loadWorkspaceLayoutContext", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns lightweight shell context without repository picker options", async () => {
    const supabase = buildSupabaseMock({
      current_step: "repository",
      selected_github_repository_id: "repo-b",
      status: "in_progress",
    });
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      supabase,
      user,
      workspace,
    });
    mocked.loadDefaultSessionRepositoryId.mockResolvedValue("repo-a");

    await expect(loadWorkspaceLayoutContext("member-access")).resolves.toEqual({
      onboarding: {
        currentStep: "repository",
        status: "in_progress",
      },
      defaultSessionGithubRepositoryId: "repo-a",
      supabase,
      user,
      workspace,
      workspaceAvatarUrl: null,
    });
    expect(mocked.loadDefaultSessionRepositoryId).toHaveBeenCalledWith({
      selectedRepositoryId: "repo-b",
      supabase,
      workspaceId: workspace.id,
    });
  });

  it("treats a missing onboarding row as setup-required state", async () => {
    const supabase = buildSupabaseMock(null);
    mocked.loadAuthenticatedWorkspaceContext.mockResolvedValue({
      supabase,
      user,
      workspace,
    });
    mocked.loadDefaultSessionRepositoryId.mockResolvedValue(null);

    await expect(loadWorkspaceLayoutContext("legacy-workspace")).resolves.toMatchObject({
      onboarding: {
        currentStep: "github",
        status: "not_started",
      },
    });
  });
});
