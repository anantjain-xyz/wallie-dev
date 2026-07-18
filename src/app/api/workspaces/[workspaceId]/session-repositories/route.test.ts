import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loadSessionRepositoryOptionsWithPrimary: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/features/sessions/repository-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/sessions/repository-options")>();
  return {
    ...actual,
    loadSessionRepositoryOptionsWithPrimary: mocked.loadSessionRepositoryOptionsWithPrimary,
  };
});

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { GET } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function routeContext(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function grantAccess(selectedGithubRepositoryId: string | null = "repo-selected") {
  const onboardingQuery = {
    eq: vi.fn(() => onboardingQuery),
    maybeSingle: vi.fn(async () => ({
      data: { selected_github_repository_id: selectedGithubRepositoryId },
      error: null,
    })),
    select: vi.fn(() => onboardingQuery),
  };
  const supabase = { from: vi.fn(() => onboardingQuery) };
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      supabase,
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
  return supabase;
}

describe("session repositories route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns options and derives the default without another repository lookup", async () => {
    const supabase = grantAccess();
    mocked.loadSessionRepositoryOptionsWithPrimary.mockResolvedValue({
      primaryGithubRepositoryId: "repo-primary",
      repositoryOptions: [
        { fullName: "acme/primary", id: "repo-primary" },
        { fullName: "acme/selected", id: "repo-selected" },
      ],
    });

    const response = await GET(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      defaultGithubRepositoryId: "repo-primary",
      repositoryOptions: [
        { fullName: "acme/primary", id: "repo-primary" },
        { fullName: "acme/selected", id: "repo-selected" },
      ],
    });
    expect(mocked.loadSessionRepositoryOptionsWithPrimary).toHaveBeenCalledTimes(1);
    expect(mocked.loadSessionRepositoryOptionsWithPrimary).toHaveBeenCalledWith({
      supabase,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("returns the authorized empty option set", async () => {
    grantAccess(null);
    mocked.loadSessionRepositoryOptionsWithPrimary.mockResolvedValue({
      primaryGithubRepositoryId: null,
      repositoryOptions: [],
    });

    const response = await GET(new Request("http://localhost"), routeContext());

    await expect(response.json()).resolves.toEqual({
      defaultGithubRepositoryId: null,
      repositoryOptions: [],
    });
  });

  it("requires workspace access before loading repositories", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace not found.",
      ok: false,
      status: 404,
    });

    const response = await GET(new Request("http://localhost"), routeContext());

    expect(response.status).toBe(404);
    expect(mocked.loadSessionRepositoryOptionsWithPrimary).not.toHaveBeenCalled();
  });
});
