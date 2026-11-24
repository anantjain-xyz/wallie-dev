import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  authorizeWorkspace: vi.fn(),
  identity: vi.fn(),
  server: vi.fn(),
  rpc: vi.fn(),
  install: vi.fn(),
  link: vi.fn(),
}));

vi.mock("@/env/server", () => ({
  parseServerEnv: () => ({
    NEXT_PUBLIC_APP_URL: "https://wallie.example",
    SLACK_APP_ID: "ATEST01",
    SLACK_CLIENT_ID: "123.456",
    SLACK_CLIENT_SECRET: "test-client-secret",
    SLACK_SIGNING_SECRET: "test-signing-secret",
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.server }));
vi.mock("@/lib/supabase/auth", () => ({ getSupabaseAuthIdentityOrNull: mocks.identity }));
vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocks.authorizeWorkspace,
}));
vi.mock("@/lib/connectors/slack/provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/slack/provider")>()),
  exchangeSlackInstallCode: mocks.install,
  exchangeSlackIdentityCode: mocks.link,
}));

import { GET, POST } from "./route";

const appUrl = "https://wallie.example";
const callback = `${appUrl}/api/slack/callback`;
const state = "a".repeat(43);
const workspaceId = "f0db1eab-d982-4f43-abbc-21eb0417faad";
const factoryId = "417e71cf-9113-44c6-9199-47bdcc986eed";
const userId = "f0803dcd-a415-4534-8d31-1d3d4efe42bd";
const installationId = "4ac824f7-c694-4347-9c28-8cad9d9d8fdb";
const sessionId = "b67debed-3938-4d24-ad06-906341362111";
const expectedFlow = {
  workspace_id: workspaceId,
  factory_id: factoryId,
  team_id: "TTEST01",
  purpose: "install",
  installation_id: null,
  expected_generation: 0,
};

function requestWithCode() {
  return new NextRequest(`${callback}?state=${state}&code=one-use-code`);
}

describe("Slack OAuth callback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("WALLIE_ENCRYPTION_KEY", "connector-callback-test-encryption");
    mocks.admin.mockReturnValue({ rpc: mocks.rpc });
    mocks.identity.mockResolvedValue({ id: userId, sessionId });
    mocks.authorizeWorkspace.mockResolvedValue({
      ok: true,
      context: { user: { id: userId }, workspace: { slug: "factory-test" } },
    });
  });

  it("consumes the session-bound authorization once and stores only encrypted bot credentials", async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: [expectedFlow], error: null })
      .mockResolvedValueOnce({
        data: [{ installation_id: installationId, generation: 1 }],
        error: null,
      })
      .mockResolvedValueOnce({ data: [], error: null });
    mocks.install.mockResolvedValue({
      appId: "ATEST01",
      teamId: "TTEST01",
      teamName: "Factory test",
      botUserId: "UTESTBOT",
      botAccessToken: "fake-provider-token",
      grantedScopes: ["chat:write"],
    });

    const first = await GET(requestWithCode());
    const second = await GET(requestWithCode());
    expect(first.headers.get("location")).toContain("slackResult=installed");
    expect(second.headers.get("location")).toBe(`${appUrl}/?slackResult=error`);
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ expectedTeamId: "TTEST01", appId: "ATEST01" }),
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, "consume_slack_connector_oauth", {
      p_state_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      p_actor_user_id: userId,
    });
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      2,
      "configure_slack_connector_installation",
      expect.objectContaining({
        p_team_id: "TTEST01",
        p_encrypted_token: expect.stringMatching(/^v2\./),
        p_granted_scopes: ["chat:write"],
      }),
    );
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("fake-provider-token");
    expect(first.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("cannot reuse captured authorization state in a different Wallie session", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await GET(requestWithCode());
    mocks.identity.mockResolvedValue({
      id: userId,
      sessionId: "a0b5c308-3569-492c-9a65-b6f385e78b16",
    });
    await GET(requestWithCode());
    expect(mocks.rpc.mock.calls[0]?.[1].p_state_digest).not.toBe(
      mocks.rpc.mock.calls[1]?.[1].p_state_digest,
    );
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("stops before Slack exchange when the current user lost workspace authorization", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [expectedFlow], error: null });
    mocks.authorizeWorkspace.mockResolvedValue({ ok: false });
    const response = await GET(requestWithCode());
    expect(response.headers.get("location")).toBe(`${appUrl}/?slackResult=error`);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it("relays form_post through a short-lived HTTPS cookie without putting the code in the redirect", async () => {
    const posted = await POST(
      new NextRequest(callback, {
        method: "POST",
        body: new URLSearchParams({ state, code: "one-use-code" }),
      }),
    );
    const cookie = posted.cookies.get("__Secure-wallie-slack-callback");
    expect(posted.headers.get("location")).toBe(`${callback}?posted=1`);
    expect(posted.headers.get("set-cookie")).toMatch(/Max-Age=60/);
    expect(posted.headers.get("set-cookie")).toContain("HttpOnly");
    expect(posted.headers.get("set-cookie")).not.toContain("one-use-code");
    expect(mocks.rpc).not.toHaveBeenCalled();
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });
    const returned = await GET(
      new NextRequest(`${callback}?posted=1`, {
        headers: { Cookie: `${cookie?.name}=${cookie?.value}` },
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(returned.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });

  it("only applies an identity verified for the exact selected team and installation generation", async () => {
    mocks.rpc
      .mockResolvedValueOnce({
        data: [
          {
            ...expectedFlow,
            purpose: "link",
            installation_id: installationId,
            expected_generation: 2,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          {
            installation_id: installationId,
            app_id: "ATEST01",
            team_id: "TTEST01",
            status: "connected",
            generation: 2,
          },
        ],
        error: null,
      })
      .mockResolvedValueOnce({ data: "45bb768a-4ed9-4173-b344-3d9e8cad9342", error: null });
    mocks.link.mockResolvedValue({ teamId: "TTEST01", userId: "UTESTER1" });

    const response = await GET(requestWithCode());
    expect(response.headers.get("location")).toContain("slackResult=linked");
    expect(mocks.link).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        expectedTeamId: "TTEST01",
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      }),
    );
    expect(mocks.rpc).toHaveBeenNthCalledWith(
      3,
      "link_connector_actor",
      expect.objectContaining({
        p_provider: "slack",
        p_installation_generation: 2,
        p_external_actor_id: "UTESTER1",
        p_actor_user_id: userId,
      }),
    );
  });
});
