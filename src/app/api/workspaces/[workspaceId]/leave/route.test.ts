import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  resolveAuthenticatedHomePath: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/auth", () => ({
  resolveAuthenticatedHomePath: mocked.resolveAuthenticatedHomePath,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";

function routeContext(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function request() {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/leave`, { method: "POST" });
}

function grantMember(role: "member" | "admin" | "owner" = "member") {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: MEMBER_ID, is_active: true, kind: "human", role },
      supabase: {},
      user: { id: "user-1" },
      workspace: { id: WORKSPACE_ID, name: "Wallie", slug: "wallie" },
    },
    ok: true,
  });
}

function mockRpc(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  mocked.createSupabaseAdminClient.mockReturnValue({ rpc });
  return { rpc };
}

describe("POST /api/workspaces/[workspaceId]/leave", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("removes the current member and returns the redirect target", async () => {
    grantMember("member");
    mocked.resolveAuthenticatedHomePath.mockResolvedValue("/onboarding/workspace");
    const { rpc } = mockRpc({
      data: [{ id: MEMBER_ID, full_name: "Casey", email: "casey@example.com", role: "member" }],
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      member: { id: MEMBER_ID, fullName: "Casey", email: "casey@example.com", role: "member" },
      redirectTo: "/onboarding/workspace",
    });
    expect(rpc).toHaveBeenCalledWith("remove_workspace_member", {
      expected_workspace_id: WORKSPACE_ID,
      target_member_id: MEMBER_ID,
    });
  });

  it("blocks the owner from leaving", async () => {
    grantMember("owner");

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "The workspace owner cannot leave. Delete the workspace instead.",
    });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid workspace id without checking access", async () => {
    const response = await POST(request(), routeContext("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });

  it("propagates the access failure status", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace not found.",
      ok: false,
      status: 404,
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(404);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("returns 404 when the member was already removed", async () => {
    grantMember("member");
    mockRpc({ data: [] });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "You are no longer a member of this workspace.",
    });
  });
});
