import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  ensureProfileForUser: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  hashWorkspaceInvitationToken: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  ensureProfileForUser: mocked.ensureProfileForUser,
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/workspace-invitations/server", () => ({
  hashWorkspaceInvitationToken: mocked.hashWorkspaceInvitationToken,
}));

import { GET } from "./route";

function routeContext(token = "invite-token") {
  return {
    params: Promise.resolve({ token }),
  };
}

function requestWith(token = "invite-token") {
  return new NextRequest(`http://localhost/invite/${token}`);
}

describe("GET /invite/[token]", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects unauthenticated invitees to login with the invite path as next", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue(null);

    const response = await GET(requestWith(), routeContext());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost/login?next=%2Finvite%2Finvite-token",
    );
  });

  it("accepts a valid invitation and redirects to the workspace", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({
      email: "new@example.com",
      id: "user-1",
      user_metadata: {
        full_name: "New Person",
        picture: "https://example.com/avatar.png",
      },
    });
    mocked.hashWorkspaceInvitationToken.mockReturnValue("hashed-token");
    mocked.rpc.mockResolvedValue({
      data: {
        invitation_id: "invitation-1",
        member: { id: "member-1", role: "member" },
        ok: true,
        workspace: { id: "workspace-1", name: "Acme", slug: "acme" },
      },
      error: null,
    });
    mocked.createSupabaseAdminClient.mockReturnValue({ rpc: mocked.rpc });

    const response = await GET(requestWith(), routeContext());

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/w/acme");
    expect(mocked.rpc).toHaveBeenCalledWith("accept_workspace_invitation", {
      actor_avatar_url: "https://example.com/avatar.png",
      actor_email: "new@example.com",
      actor_full_name: "New Person",
      actor_user_id: "user-1",
      invitation_token_hash: "hashed-token",
    });
  });

  it("renders an email mismatch error instead of granting workspace access", async () => {
    mocked.createSupabaseServerClient.mockResolvedValue({});
    mocked.getSupabaseUserOrNull.mockResolvedValue({
      email: "wrong@example.com",
      id: "user-1",
      user_metadata: {},
    });
    mocked.hashWorkspaceInvitationToken.mockReturnValue("hashed-token");
    mocked.rpc.mockResolvedValue({
      data: {
        actor_email: "wrong@example.com",
        error_code: "email_mismatch",
        invited_email: "new@example.com",
        ok: false,
      },
      error: null,
    });
    mocked.createSupabaseAdminClient.mockReturnValue({ rpc: mocked.rpc });

    const response = await GET(requestWith(), routeContext());

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("Use the invited email");
  });
});
