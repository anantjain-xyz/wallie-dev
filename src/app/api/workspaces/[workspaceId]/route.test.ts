import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  resolveAuthenticatedHomePath: vi.fn(),
  resumeWorkspaceDeletion: vi.fn().mockResolvedValue(true),
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

vi.mock("@/lib/workspaces/deletion", () => ({
  resumeWorkspaceDeletion: mocked.resumeWorkspaceDeletion,
}));

import { DELETE, PATCH } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function requestWith(body: unknown) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
}

function routeContext(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
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

function mockUpdateResult(result: {
  data?: { id: string; name: string; updated_at: string } | null;
  error?: unknown;
}) {
  const single = vi
    .fn()
    .mockResolvedValue({ data: result.data ?? null, error: result.error ?? null });
  const select = vi.fn().mockReturnValue({ single });
  const eq = vi.fn().mockReturnValue({ select });
  const update = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ update });
  mocked.createSupabaseAdminClient.mockReturnValue({ from });
  return { eq, from, select, single, update };
}

describe("PATCH /api/workspaces/[workspaceId]", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renames the workspace for a manager", async () => {
    grantAccess();
    const calls = mockUpdateResult({
      data: { id: WORKSPACE_ID, name: "Northwind Labs", updated_at: "2026-06-12T00:00:00Z" },
    });

    const response = await PATCH(requestWith({ name: "  Northwind Labs  " }), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: WORKSPACE_ID,
      name: "Northwind Labs",
      updatedAt: "2026-06-12T00:00:00Z",
    });
    expect(calls.from).toHaveBeenCalledWith("workspaces");
    expect(calls.update).toHaveBeenCalledWith({ name: "Northwind Labs" });
    expect(calls.eq).toHaveBeenCalledWith("id", WORKSPACE_ID);
  });

  it("rejects an invalid workspace id without touching the database", async () => {
    const response = await PATCH(requestWith({ name: "Northwind" }), routeContext("not-a-uuid"));

    expect(response.status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects an empty name with a 400 before checking access", async () => {
    const response = await PATCH(requestWith({ name: "   " }), routeContext());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Workspace name is required." });
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });

  it("rejects a name longer than 80 characters", async () => {
    const response = await PATCH(requestWith({ name: "a".repeat(81) }), routeContext());

    expect(response.status).toBe(400);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("propagates the access failure status for non-managers", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace admin access is required for this action.",
      ok: false,
      status: 403,
    });

    const response = await PATCH(requestWith({ name: "Northwind" }), routeContext());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Workspace admin access is required for this action.",
    });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("requires manager access", async () => {
    grantAccess();
    mockUpdateResult({ data: { id: WORKSPACE_ID, name: "x", updated_at: "2026-06-12T00:00:00Z" } });

    await PATCH(requestWith({ name: "x" }), routeContext());

    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(WORKSPACE_ID, {
      requireManager: true,
    });
  });

  it("returns 500 when the update fails", async () => {
    grantAccess();
    mockUpdateResult({ data: null, error: new Error("db down") });

    const response = await PATCH(requestWith({ name: "Northwind" }), routeContext());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to update workspace name." });
  });
});

function deleteRequestWith(body: unknown) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "DELETE",
  });
}

function mockDeleteResult(error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data: "2026-10-10T00:00:00Z", error });
  const admin = { rpc };
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
  return admin;
}

describe("DELETE /api/workspaces/[workspaceId]", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("fences the confirmed owner request before cleanup and redirects only after deletion", async () => {
    grantAccess();
    mocked.resolveAuthenticatedHomePath.mockResolvedValue("/onboarding/workspace");
    const admin = mockDeleteResult();
    mocked.resumeWorkspaceDeletion.mockResolvedValue(true);
    const response = await DELETE(deleteRequestWith({ confirmation: "Wallie" }), routeContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, redirectTo: "/onboarding/workspace" });
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(WORKSPACE_ID, {
      allowDeleting: true,
      requireOwner: true,
    });
    expect(admin.rpc).toHaveBeenCalledWith("begin_workspace_deletion", {
      p_confirmation: "Wallie",
      p_owner_member_id: "member-1",
      p_workspace_id: WORKSPACE_ID,
    });
    expect(mocked.resumeWorkspaceDeletion).toHaveBeenCalledWith(admin, WORKSPACE_ID);
    expect(admin.rpc.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.resumeWorkspaceDeletion.mock.invocationCallOrder[0]!,
    );
  });

  it("returns pending cleanup without a redirect and permits a successful retry", async () => {
    grantAccess();
    mockDeleteResult();
    mocked.resumeWorkspaceDeletion.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocked.resolveAuthenticatedHomePath.mockResolvedValue("/w/next");
    const pending = await DELETE(deleteRequestWith({ confirmation: "Wallie" }), routeContext());
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({
      deleted: false,
      message:
        "Workspace deletion is in progress. Cleanup will retry automatically; you can also retry here.",
    });
    expect(mocked.resolveAuthenticatedHomePath).not.toHaveBeenCalled();
    const retry = await DELETE(deleteRequestWith({ confirmation: "Wallie" }), routeContext());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ deleted: true, redirectTo: "/w/next" });
  });

  it("keeps provider or storage errors pending for durable worker recovery", async () => {
    grantAccess();
    mockDeleteResult();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocked.resumeWorkspaceDeletion.mockRejectedValueOnce(new Error("storage unavailable"));
    const response = await DELETE(deleteRequestWith({ confirmation: "Wallie" }), routeContext());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ deleted: false });
    expect(mocked.resolveAuthenticatedHomePath).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    { code: "42501", status: 403 },
    { code: "22023", status: 400 },
    { code: "XX000", status: 500 },
  ])(
    "does not clean up when the atomic owner/name guard fails with $code",
    async ({ code, status }) => {
      grantAccess();
      mockDeleteResult({ code });
      const response = await DELETE(deleteRequestWith({ confirmation: "Wallie" }), routeContext());
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "Failed to request workspace deletion." });
      expect(mocked.resumeWorkspaceDeletion).not.toHaveBeenCalled();
    },
  );

  it("rejects a mismatched name before committing the fence", async () => {
    grantAccess();
    const admin = mockDeleteResult();
    const response = await DELETE(deleteRequestWith({ confirmation: "wallie" }), routeContext());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Type the workspace name exactly to confirm deletion.",
    });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid ids before authorization", async () => {
    const response = await DELETE(
      deleteRequestWith({ confirmation: "Wallie" }),
      routeContext("not-a-uuid"),
    );
    expect(response.status).toBe(400);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });

  it("preserves the authorization failure", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Owner required.",
    });
    const response = await DELETE(deleteRequestWith({ confirmation: "Wallie" }), routeContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Owner required." });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});
