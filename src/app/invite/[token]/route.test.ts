import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  getSupabaseUserOrNull: vi.fn(),
  hashWorkspaceInvitationToken: vi.fn(),
  rpc: vi.fn(),
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
    const html = await response.text();
    expect(html).toContain("Use the invited email");
    expect(html).toContain("Sign out, then sign in with the email address");
    expect(html).toContain('action="/auth/signout" method="post"');
    expect(html).toContain('name="next" value="/invite/invite-token"');
    expect(html.indexOf("Use a different account")).toBeLessThan(html.indexOf("Back to Wallie"));
    expect(html).not.toContain("new@example.com");
    expect(html).not.toContain("wrong@example.com");
    expect(html).toContain('href="/"');
  });
  it.each([
    ["expired", 410, "Ask the person who invited you to send a new link."],
    ["revoked", 410, "Ask the person who invited you to send a new link."],
    ["already_accepted", 409, "with the account that received the invitation."],
    ["not_found", 404, "Ask the person who invited you to send a new link."],
  ])(
    "offers a safe next step and return destination without signing out for %s",
    async (errorCode, status, guidance) => {
      mocked.createSupabaseServerClient.mockResolvedValue({});
      mocked.getSupabaseUserOrNull.mockResolvedValue({ id: "user-1", email: "user@example.com" });
      mocked.createSupabaseAdminClient.mockReturnValue({ rpc: mocked.rpc });
      mocked.rpc.mockResolvedValue({ data: { ok: false, error_code: errorCode }, error: null });
      const response = await GET(requestWith(), routeContext());
      expect(response.status).toBe(status);
      const html = await response.text();
      expect(html).toContain(guidance);
      expect(html).toContain('href="/"');
      expect(html).not.toContain('action="/auth/signout"');
    },
  );
});
