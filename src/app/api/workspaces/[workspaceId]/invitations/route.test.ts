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

const savedInvitation = {
  accepted_at: null,
  accepted_by_member_id: null,
  created_at: "2026-06-05T12:00:00.000Z",
  email: "new@example.com",
  expires_at: "2026-06-12T12:00:00.000Z",
  id: "22222222-2222-4222-8222-222222222222",
  invited_by_member_id: MEMBER_ID,
  last_sent_at: "2026-06-05T12:00:00.000Z",
  revoked_at: null,
  role: "member",
  status: "pending",
  token_hash: "hashed-token",
  updated_at: "2026-06-05T12:00:00.000Z",
  workspace_id: WORKSPACE_ID,
};

function routeContext(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

function requestWith(body: unknown) {
  return new Request(`http://localhost/api/workspaces/${WORKSPACE_ID}/invitations`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValue({
    context: {
      currentMember: { id: MEMBER_ID, is_active: true, kind: "human", role: "owner" },
      workspace: { id: WORKSPACE_ID, name: "Acme", slug: "acme" },
    },
    ok: true,
  });
}

function setupDefaults() {
  grantAccess();
  mocked.createSupabaseAdminClient.mockReturnValue({ from: mocked.from, auth: {} });
  mocked.enforceRateLimit.mockResolvedValue({ response: null, result: { success: true } });
  mocked.createWorkspaceInvitationToken.mockReturnValue("raw-token");
  mocked.hashWorkspaceInvitationToken.mockReturnValue("hashed-token");
  mocked.workspaceInvitationExpiresAt.mockReturnValue(new Date("2026-06-12T12:00:00.000Z"));
  mocked.buildWorkspaceInvitationAcceptUrl.mockReturnValue("http://localhost/invite/raw-token");
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
    delete: vi.fn(() => query),
    eq: vi.fn(() => query),
    insert: vi.fn(() => query),
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

describe("POST /api/workspaces/[workspaceId]/invitations", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a pending invitation and sends an email without returning the token", async () => {
    setupDefaults();
    const activeMemberQuery = selectMaybeQuery({ data: null, error: null });
    const existingInviteQuery = selectMaybeQuery({ data: null, error: null });
    const insertQuery = mutationQuery({ data: savedInvitation, error: null });
    wireFrom(activeMemberQuery, existingInviteQuery, insertQuery);

    const response = await POST(requestWith({ email: "New@Example.com" }), routeContext());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      invitation: {
        acceptedAt: null,
        acceptedByMemberId: null,
        createdAt: "2026-06-05T12:00:00.000Z",
        email: "new@example.com",
        expiresAt: "2026-06-12T12:00:00.000Z",
        id: "22222222-2222-4222-8222-222222222222",
        invitedByMemberId: MEMBER_ID,
        lastSentAt: "2026-06-05T12:00:00.000Z",
        revokedAt: null,
        role: "member",
        status: "pending",
        updatedAt: "2026-06-05T12:00:00.000Z",
        workspaceId: WORKSPACE_ID,
      },
    });
    expect(insertQuery.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "new@example.com",
        role: "member",
        status: "pending",
        token_hash: "hashed-token",
        workspace_id: WORKSPACE_ID,
      }),
    );
    expect(mocked.sendWorkspaceInvitationEmail).toHaveBeenCalledWith({
      acceptUrl: "http://localhost/invite/raw-token",
      admin: { from: mocked.from, auth: {} },
      email: "new@example.com",
    });
  });

  it("resends an existing pending invite by rotating the token and role", async () => {
    setupDefaults();
    const activeMemberQuery = selectMaybeQuery({ data: null, error: null });
    const existingInviteQuery = selectMaybeQuery({ data: savedInvitation, error: null });
    const updateQuery = mutationQuery({
      data: { ...savedInvitation, role: "admin" },
      error: null,
    });
    wireFrom(activeMemberQuery, existingInviteQuery, updateQuery);

    const response = await POST(
      requestWith({ email: "new@example.com", role: "admin" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(updateQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "admin",
        token_hash: "hashed-token",
      }),
    );
  });

  it("rejects inviting an already active member", async () => {
    setupDefaults();
    const activeMemberQuery = selectMaybeQuery({ data: { id: "member-2" }, error: null });
    wireFrom(activeMemberQuery);

    const response = await POST(requestWith({ email: "new@example.com" }), routeContext());

    expect(response.status).toBe(409);
    expect(mocked.sendWorkspaceInvitationEmail).not.toHaveBeenCalled();
  });

  it("cleans up a new pending invite if email delivery fails", async () => {
    setupDefaults();
    mocked.sendWorkspaceInvitationEmail.mockRejectedValue(new Error("SMTP unavailable"));
    const activeMemberQuery = selectMaybeQuery({ data: null, error: null });
    const existingInviteQuery = selectMaybeQuery({ data: null, error: null });
    const insertQuery = mutationQuery({ data: savedInvitation, error: null });
    const cleanupQuery = mutationQuery({ data: null, error: null });
    wireFrom(activeMemberQuery, existingInviteQuery, insertQuery, cleanupQuery);

    const response = await POST(requestWith({ email: "new@example.com" }), routeContext());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: "SMTP unavailable" });
    expect(cleanupQuery.delete).toHaveBeenCalled();
    expect(cleanupQuery.eq).toHaveBeenCalledWith("id", savedInvitation.id);
  });

  it("returns the configured rate-limit response before parsing the invite body", async () => {
    setupDefaults();
    const rateLimitResponse = Response.json({ error: "Rate limit exceeded." }, { status: 429 });
    mocked.enforceRateLimit.mockResolvedValue({
      response: rateLimitResponse,
      result: { success: false },
    });

    const response = await POST(requestWith({ email: "new@example.com" }), routeContext());

    expect(response.status).toBe(429);
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });
});
