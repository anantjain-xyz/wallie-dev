import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  buildWorkspaceInvitationAcceptUrl: vi.fn(),
  createSupabaseAdminClient: vi.fn(),
  createWorkspaceInvitationToken: vi.fn(),
  enforceRateLimit: vi.fn(),
  from: vi.fn(),
  hashWorkspaceInvitationToken: vi.fn(),
  requireWorkspaceAccessById: vi.fn(),
  sendWorkspaceInvitationEmail: vi.fn(),
  workspaceInvitationExpiresAt: vi.fn(),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: mocked.enforceRateLimit,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/workspace-invitations/server", () => ({
  buildWorkspaceInvitationAcceptUrl: mocked.buildWorkspaceInvitationAcceptUrl,
  createWorkspaceInvitationToken: mocked.createWorkspaceInvitationToken,
  hashWorkspaceInvitationToken: mocked.hashWorkspaceInvitationToken,
  sendWorkspaceInvitationEmail: mocked.sendWorkspaceInvitationEmail,
  workspaceInvitationExpiresAt: mocked.workspaceInvitationExpiresAt,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "11111111-1111-4111-8111-111111111111";
const INVITATION_ID = "22222222-2222-4222-8222-222222222222";

const pendingInvitation = {
  accepted_at: null,
  accepted_by_member_id: null,
  created_at: "2026-06-05T12:00:00.000Z",
  email: "new@example.com",
  expires_at: "2026-06-12T12:00:00.000Z",
  id: INVITATION_ID,
  invited_by_member_id: MEMBER_ID,
  last_sent_at: "2026-06-05T12:00:00.000Z",
  revoked_at: null,
  role: "admin",
  status: "pending",
  token_hash: "old-hash",
  updated_at: "2026-06-05T12:00:00.000Z",
  workspace_id: WORKSPACE_ID,
};

function routeContext() {
  return {
    params: Promise.resolve({ invitationId: INVITATION_ID, workspaceId: WORKSPACE_ID }),
  };
}

function setupDefaults() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: MEMBER_ID, is_active: true, kind: "human", role: "owner" },
      workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
    },
    ok: true,
  });
  mocked.createSupabaseAdminClient.mockReturnValue({ from: mocked.from, auth: {} });
  mocked.enforceRateLimit.mockResolvedValue({ response: null, result: { success: true } });
  mocked.createWorkspaceInvitationToken.mockReturnValue("new-token");
  mocked.hashWorkspaceInvitationToken.mockReturnValue("new-hash");
  mocked.workspaceInvitationExpiresAt.mockReturnValue(new Date("2026-06-12T12:00:00.000Z"));
  mocked.buildWorkspaceInvitationAcceptUrl.mockReturnValue(
    "https://wallie.dev/auth/confirm?next=%2Finvite%2Fnew-token",
  );
  mocked.sendWorkspaceInvitationEmail.mockResolvedValue(undefined);
}

function selectMaybeQuery(result: unknown) {
  const query = {
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(() => Promise.resolve(result)),
    select: vi.fn(() => query),
  };
  return query;
}

function mutationQuery(result: unknown) {
  const query = {
    eq: vi.fn(() => query),
    select: vi.fn(() => query),
    single: vi.fn(() => Promise.resolve(result)),
    update: vi.fn(() => query),
  };
  return query;
}

function wireFrom(...queries: unknown[]) {
  mocked.from.mockImplementation(() => {
    const query = queries.shift();
    if (!query) {
      throw new Error("Unexpected Supabase query");
    }
    return query;
  });
}

describe("POST /api/workspaces/[workspaceId]/invitations/[invitationId]/resend", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rotates the token and sends the invitation email", async () => {
    setupDefaults();
    const lookupQuery = selectMaybeQuery({ data: pendingInvitation, error: null });
    const updateQuery = mutationQuery({
      data: { ...pendingInvitation, token_hash: "new-hash" },
      error: null,
    });
    wireFrom(lookupQuery, updateQuery);

    const response = await POST(
      new Request(
        `http://localhost/api/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}/resend`,
        {
          method: "POST",
        },
      ),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ token_hash: "new-hash" }),
    );
    expect(mocked.buildWorkspaceInvitationAcceptUrl).toHaveBeenCalledWith("new-token");
    expect(mocked.sendWorkspaceInvitationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptUrl: "https://wallie.dev/auth/confirm?next=%2Finvite%2Fnew-token",
        email: "new@example.com",
      }),
    );
  });

  it("restores the previous token fields when email delivery fails", async () => {
    setupDefaults();
    mocked.sendWorkspaceInvitationEmail.mockRejectedValue(new Error("email failed"));
    const lookupQuery = selectMaybeQuery({ data: pendingInvitation, error: null });
    const updateQuery = mutationQuery({
      data: { ...pendingInvitation, token_hash: "new-hash" },
      error: null,
    });
    const restoreQuery = mutationQuery({ data: null, error: null });
    wireFrom(lookupQuery, updateQuery, restoreQuery);

    const response = await POST(
      new Request(
        `http://localhost/api/workspaces/${WORKSPACE_ID}/invitations/${INVITATION_ID}/resend`,
        {
          method: "POST",
        },
      ),
      routeContext(),
    );

    expect(response.status).toBe(502);
    expect(restoreQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ token_hash: "old-hash" }),
    );
  });
});
