import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { PATCH } from "./route";

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
