import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  inferRepositoryProfileForRepository: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/repo-inference/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repo-inference/server")>();
  return {
    RepositoryProfileError: actual.RepositoryProfileError,
    inferRepositoryProfileForRepository: mocked.inferRepositoryProfileForRepository,
  };
});

import { RepositoryProfileError } from "@/lib/repo-inference/server";

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";

function routeContext(repositoryId = REPOSITORY_ID, workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ repositoryId, workspaceId }),
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

describe("repository inference route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires manager access", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace admin access is required for this action.",
      ok: false,
      status: 403,
    });

    const response = await POST(
      new Request("http://localhost", { method: "POST" }),
      routeContext(),
    );

    expect(response.status).toBe(403);
    expect(mocked.inferRepositoryProfileForRepository).not.toHaveBeenCalled();
  });

  it("returns an inferred profile draft", async () => {
    grantAccess();
    const admin = {};
    const profile = {
      buildCommand: "pnpm build",
      createdAt: null,
      envKeySuggestions: ["DATABASE_URL"],
      frameworkHints: ["next"],
      githubRepositoryId: REPOSITORY_ID,
      id: null,
      inferenceConfidence: "high",
      inferenceSources: [{ path: "package.json", reason: "Read for static inference" }],
      installCommand: "pnpm install",
      isPrimary: true,
      languageHints: ["javascript"],
      packageManager: "pnpm",
      setupNotes: "",
      testCommand: "pnpm test",
      updatedAt: null,
      workspaceId: WORKSPACE_ID,
    };
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.inferRepositoryProfileForRepository.mockResolvedValue(profile);

    const response = await POST(
      new Request("http://localhost", { method: "POST" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ profile });
    expect(mocked.inferRepositoryProfileForRepository).toHaveBeenCalledWith({
      admin,
      repositoryId: REPOSITORY_ID,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("returns 404 for missing repositories", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValue({});
    mocked.inferRepositoryProfileForRepository.mockRejectedValue(
      new RepositoryProfileError("Repository not found.", 404),
    );

    const response = await POST(
      new Request("http://localhost", { method: "POST" }),
      routeContext(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Repository not found." });
  });

  it("rejects archived repositories", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValue({});
    mocked.inferRepositoryProfileForRepository.mockRejectedValue(
      new RepositoryProfileError("Archived repositories cannot be selected.", 400),
    );

    const response = await POST(
      new Request("http://localhost", { method: "POST" }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Archived repositories cannot be selected.",
    });
  });
});
