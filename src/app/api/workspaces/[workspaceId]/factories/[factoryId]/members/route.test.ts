import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  grantFactoryMembership: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  revokeFactoryMembership: vi.fn(),
}));

vi.mock("@/lib/factories/scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/factories/scope")>();
  return {
    ...actual,
    grantFactoryMembership: mocked.grantFactoryMembership,
    revokeFactoryMembership: mocked.revokeFactoryMembership,
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { DELETE, POST } from "./route";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const factoryId = "00000000-0000-4000-8000-000000000002";
const actorUserId = "00000000-0000-4000-8000-000000000003";
const memberId = "00000000-0000-4000-8000-000000000004";
const routeUrl = `http://localhost/api/workspaces/${workspaceId}/factories/${factoryId}/members`;
const context = { params: Promise.resolve({ factoryId, workspaceId }) };
const admin = { rpc: vi.fn() };
const membership = {
  id: "00000000-0000-4000-8000-000000000005",
  workspace_id: workspaceId,
  factory_id: factoryId,
  member_id: memberId,
  role: "member",
  granted_by_member_id: actorUserId,
  granted_at: "2026-11-16T00:00:00Z",
  revoked_by_member_id: null,
  revoked_at: null,
  revoke_reason: null,
};

function request(method: "DELETE" | "POST", body: unknown) {
  return new Request(routeUrl, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocked.createSupabaseAdminClient.mockReturnValue(admin);
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    ok: true,
    context: {
      currentMember: { id: "member-id", role: "owner" },
      supabase: { from: vi.fn() },
      user: { id: actorUserId },
      workspace: { id: workspaceId },
    },
  });
});

describe("factory membership route", () => {
  it("grants a role through the audited command", async () => {
    mocked.grantFactoryMembership.mockResolvedValue(membership);
    const response = await POST(request("POST", { memberId, role: "member" }), context);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ membership });
    expect(mocked.grantFactoryMembership).toHaveBeenCalledWith(admin, {
      actorUserId,
      factoryId,
      memberId,
      role: "member",
      workspaceId,
    });
  });

  it("revokes with an optional reason", async () => {
    mocked.revokeFactoryMembership.mockResolvedValue({
      ...membership,
      revoked_at: "2026-11-16T01:00:00Z",
    });
    const response = await DELETE(request("DELETE", { memberId, reason: "Moved teams" }), context);
    expect(response.status).toBe(200);
    expect(mocked.revokeFactoryMembership).toHaveBeenCalledWith(admin, {
      actorUserId,
      factoryId,
      memberId,
      reason: "Moved teams",
      workspaceId,
    });
  });

  it("rejects a missing member id", async () => {
    const response = await POST(request("POST", { role: "member" }), context);
    expect(response.status).toBe(400);
    expect(mocked.grantFactoryMembership).not.toHaveBeenCalled();
  });

  it("maps the last-manager guard to an unprocessable response", async () => {
    mocked.revokeFactoryMembership.mockRejectedValue({ code: "23514" });
    const response = await DELETE(request("DELETE", { memberId }), context);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "A factory must retain at least one manager.",
    });
  });
});
