import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  from: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

import { DELETE, PATCH } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const CURRENT_MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_MEMBER_ID = "22222222-2222-4222-8222-222222222222";

function routeContext(memberId = TARGET_MEMBER_ID) {
  return {
    params: Promise.resolve({ memberId, workspaceId: WORKSPACE_ID }),
  };
}

/**
 * A chainable query stub whose `maybeSingle` resolves the queued results in
 * order. The route fetches the target first, then performs the mutation, so
 * each `from("workspace_members")` chain ends in one `maybeSingle` call.
 */
function adminWith(...maybeSingleResults: unknown[]) {
  const queue = [...maybeSingleResults];
  const lastQuery = { update: vi.fn(), eq: vi.fn(), select: vi.fn() } as Record<string, unknown>;
  mocked.from.mockImplementation(() => {
    const query: Record<string, unknown> = {
      eq: vi.fn(() => query),
      select: vi.fn(() => query),
      update: vi.fn(() => query),
      maybeSingle: vi.fn(() => Promise.resolve(queue.shift() ?? { data: null, error: null })),
    };
    lastQuery.update = query.update;
    lastQuery.eq = query.eq;
    lastQuery.select = query.select;
    return query;
  });
  mocked.createSupabaseAdminClient.mockReturnValue({ from: mocked.from });
  return lastQuery;
}

function grantManager(role: "owner" | "admin" = "admin") {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: CURRENT_MEMBER_ID, is_active: true, kind: "human", role },
      workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
    },
    ok: true,
  });
}

function patchRequest(body: unknown) {
  return new Request(
    `http://localhost/api/workspaces/${WORKSPACE_ID}/members/${TARGET_MEMBER_ID}`,
    { body: JSON.stringify(body), method: "PATCH" },
  );
}

function deleteRequest() {
  return new Request(
    `http://localhost/api/workspaces/${WORKSPACE_ID}/members/${TARGET_MEMBER_ID}`,
    { method: "DELETE" },
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/workspaces/[workspaceId]/members/[memberId]", () => {
  it("promotes a member to admin", async () => {
    grantManager();
    const lastQuery = adminWith(
      {
        data: { id: TARGET_MEMBER_ID, role: "member", kind: "human", is_active: true },
        error: null,
      },
      {
        data: { id: TARGET_MEMBER_ID, full_name: "Mara", email: "mara@example.com", role: "admin" },
        error: null,
      },
    );

    const response = await PATCH(patchRequest({ role: "admin" }), routeContext());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.member.role).toBe("admin");
    expect(lastQuery.update).toHaveBeenCalledWith({ role: "admin" });
    expect(lastQuery.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("rejects a non-manager", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace admin access is required for this action.",
      ok: false,
      status: 403,
    });

    const response = await PATCH(patchRequest({ role: "admin" }), routeContext());

    expect(response.status).toBe(403);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("refuses to change your own role", async () => {
    grantManager();

    const response = await PATCH(patchRequest({ role: "member" }), routeContext(CURRENT_MEMBER_ID));

    expect(response.status).toBe(400);
    expect(mocked.from).not.toHaveBeenCalled();
  });

  it("refuses to change the owner's role", async () => {
    grantManager();
    adminWith({
      data: { id: TARGET_MEMBER_ID, role: "owner", kind: "human", is_active: true },
      error: null,
    });

    const response = await PATCH(patchRequest({ role: "member" }), routeContext());

    expect(response.status).toBe(403);
  });

  it("returns 404 when the target is not an active human member", async () => {
    grantManager();
    adminWith({ data: null, error: null });

    const response = await PATCH(patchRequest({ role: "admin" }), routeContext());

    expect(response.status).toBe(404);
  });

  it("rejects an invalid role", async () => {
    grantManager();
    adminWith({
      data: { id: TARGET_MEMBER_ID, role: "member", kind: "human", is_active: true },
      error: null,
    });

    const response = await PATCH(patchRequest({ role: "owner" }), routeContext());

    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/workspaces/[workspaceId]/members/[memberId]", () => {
  it("soft-removes an active member", async () => {
    grantManager();
    const lastQuery = adminWith(
      {
        data: { id: TARGET_MEMBER_ID, role: "member", kind: "human", is_active: true },
        error: null,
      },
      {
        data: {
          id: TARGET_MEMBER_ID,
          full_name: "Mara",
          email: "mara@example.com",
          role: "member",
        },
        error: null,
      },
    );

    const response = await DELETE(deleteRequest(), routeContext());

    expect(response.status).toBe(200);
    expect(lastQuery.update).toHaveBeenCalledWith({ is_active: false });
  });

  it("refuses to remove yourself", async () => {
    grantManager();

    const response = await DELETE(deleteRequest(), routeContext(CURRENT_MEMBER_ID));

    expect(response.status).toBe(400);
    expect(mocked.from).not.toHaveBeenCalled();
  });

  it("refuses to remove the owner", async () => {
    grantManager();
    adminWith({
      data: { id: TARGET_MEMBER_ID, role: "owner", kind: "human", is_active: true },
      error: null,
    });

    const response = await DELETE(deleteRequest(), routeContext());

    expect(response.status).toBe(403);
  });

  it("rejects a non-manager", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      error: "Workspace admin access is required for this action.",
      ok: false,
      status: 403,
    });

    const response = await DELETE(deleteRequest(), routeContext());

    expect(response.status).toBe(403);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});
