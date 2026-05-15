import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  getRepositoryOnboardingState: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  startRepositoryOnboarding: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/repo-onboarding/server", () => ({
  getRepositoryOnboardingState: mocked.getRepositoryOnboardingState,
  startRepositoryOnboarding: mocked.startRepositoryOnboarding,
}));

import { GET, POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";

const onboarding = {
  conflictReport: [],
  githubRepositoryId: REPOSITORY_ID,
  installedSkillHash: null,
  installedSkillVersion: null,
  lastError: null,
  setupBranchName: "wallie/setup-app",
  setupPrNumber: 12,
  setupPrUrl: "https://github.com/acme/app/pull/12",
  status: "pr_open",
  updatedAt: "2026-05-15T00:00:00.000Z",
};

function routeContext() {
  return {
    params: Promise.resolve({ repositoryId: REPOSITORY_ID, workspaceId: WORKSPACE_ID }),
  };
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: "member-1", is_active: true, kind: "human", role: "owner" },
      supabase: {},
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
}

describe("repository onboarding route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns stored onboarding state", async () => {
    grantAccess();
    const admin = {};
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.getRepositoryOnboardingState.mockResolvedValue(onboarding);

    const response = await GET(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ onboarding });
    expect(mocked.getRepositoryOnboardingState).toHaveBeenCalledWith({
      admin,
      repositoryId: REPOSITORY_ID,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("starts onboarding for the repository", async () => {
    grantAccess();
    const admin = {};
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.startRepositoryOnboarding.mockResolvedValue({ onboarding });

    const response = await POST(
      new Request("http://localhost", { method: "POST" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ onboarding });
    expect(mocked.startRepositoryOnboarding).toHaveBeenCalledWith({
      admin,
      repositoryId: REPOSITORY_ID,
      workspaceId: WORKSPACE_ID,
    });
  });
});
