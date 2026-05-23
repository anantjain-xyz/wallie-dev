import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  saveWorkspaceRepositoryProfile: vi.fn(),
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
    saveWorkspaceRepositoryProfile: mocked.saveWorkspaceRepositoryProfile,
  };
});

import { RepositoryProfileError } from "@/lib/repo-inference/server";

import { PUT } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const REPOSITORY_ID = "11111111-1111-4111-8111-111111111111";

const validPayload = {
  buildCommand: "pnpm build",
  envKeySuggestions: ["DATABASE_URL"],
  frameworkHints: ["next"],
  githubRepositoryId: REPOSITORY_ID,
  inferenceConfidence: "manual",
  inferenceSources: [{ path: "package.json", reason: "Read for static inference" }],
  installCommand: "pnpm install",
  languageHints: ["javascript"],
  packageManager: "pnpm",
  setupNotes: "Use Supabase project secrets.",
  testCommand: "pnpm test",
};

function routeContext(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

function request(body: unknown) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/repository-profile`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PUT",
  });
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

describe("repository profile route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("saves a selected repository profile", async () => {
    grantAccess();
    const admin = {};
    const profile = {
      ...validPayload,
      createdAt: "2026-05-16T18:00:00.000Z",
      id: "profile-1",
      isPrimary: true,
      updatedAt: "2026-05-16T18:00:00.000Z",
      workspaceId: WORKSPACE_ID,
    };
    mocked.createSupabaseAdminClient.mockReturnValue(admin);
    mocked.saveWorkspaceRepositoryProfile.mockResolvedValue(profile);

    const response = await PUT(request(validPayload), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ profile });
    expect(mocked.saveWorkspaceRepositoryProfile).toHaveBeenCalledWith({
      admin,
      payload: validPayload,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("rejects invalid save payloads", async () => {
    grantAccess();

    const response = await PUT(
      request({ ...validPayload, envKeySuggestions: ["DATABASE-URL"] }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    expect(mocked.saveWorkspaceRepositoryProfile).not.toHaveBeenCalled();
  });

  it("requires manager access", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace admin access is required for this action.",
      ok: false,
      status: 403,
    });

    const response = await PUT(request(validPayload), routeContext());

    expect(response.status).toBe(403);
    expect(mocked.saveWorkspaceRepositoryProfile).not.toHaveBeenCalled();
  });

  it("returns active profile uniqueness conflicts", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValue({});
    mocked.saveWorkspaceRepositoryProfile.mockRejectedValue(
      new RepositoryProfileError(
        "Only one saved repository profile can be active per workspace.",
        409,
      ),
    );

    const response = await PUT(request(validPayload), routeContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Only one saved repository profile can be active per workspace.",
    });
  });
});
