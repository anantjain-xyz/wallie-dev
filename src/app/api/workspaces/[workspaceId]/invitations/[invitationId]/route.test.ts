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

import { DELETE } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";

const revokedInvitation = {
  accepted_at: null,
  accepted_by_member_id: null,
  created_at: "2026-06-05T12:00:00.000Z",
  email: "new@example.com",
  expires_at: "2026-06-12T12:00:00.000Z",
  id: INVITATION_ID,
  invited_by_member_id: "11111111-1111-4111-8111-111111111111",
  last_sent_at: "2026-06-05T12:00:00.000Z",
  revoked_at: "2026-06-05T12:30:00.000Z",
  role: "member",
  status: "revoked",
  updated_at: "2026-06-05T12:30:00.000Z",
  workspace_id: WORKSPACE_ID,
};

function routeContext() {
  return {
    params: Promise.resolve({ invitationId: INVITATION_ID, workspaceId: WORKSPACE_ID }),
  };
}

function mutationQuery(result: unknown) {
  const query = {
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    select: vi.fn(() => query),
    update: vi.fn(() => query),
  };
  return query;
}

describe("DELETE /api/workspaces/[workspaceId]/invitations/[invitationId]", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("revokes only a pending invitation in the target workspace", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      context: {
        currentMember: { id: "member-1", is_active: true, kind: "human", role: "admin" },
        workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
      },
      ok: true,
    });
    const updateQuery = mutationQuery({ data: revokedInvitation, error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({ from: mocked.from });
    mocked.from.mockReturnValue(updateQuery);

    const response = await DELETE(
      new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}`, {
        method: "DELETE",
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: "revoked" }));
    expect(updateQuery.eq).toHaveBeenCalledWith("workspace_id", WORKSPACE_ID);
    expect(updateQuery.eq).toHaveBeenCalledWith("status", "pending");
  });

  it("returns 404 when no pending invitation is updated", async () => {
    mocked.requireWorkspaceAccessById.mockResolvedValue({
      context: {
        currentMember: { id: "member-1", is_active: true, kind: "human", role: "admin" },
        workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
      },
      ok: true,
    });
    const updateQuery = mutationQuery({ data: null, error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({ from: mocked.from });
    mocked.from.mockReturnValue(updateQuery);

    const response = await DELETE(
      new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}`, {
        method: "DELETE",
      }),
      routeContext(),
    );

    expect(response.status).toBe(404);
  });
});
