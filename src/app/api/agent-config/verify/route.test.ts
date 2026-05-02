import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  class CodexNotConnectedErrorMock extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CodexNotConnectedError";
    }
  }
  return {
    createSupabaseAdminClient: vi.fn(),
    requireWorkspaceAccessById: vi.fn(),
    decryptSecretValue: vi.fn(),
    getCodexAccessTokenForUser: vi.fn(),
    CodexNotConnectedError: CodexNotConnectedErrorMock,
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

vi.mock("@/lib/codex/tokens", () => ({
  getCodexAccessTokenForUser: mocked.getCodexAccessTokenForUser,
  CodexNotConnectedError: mocked.CodexNotConnectedError,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "user-1";

function postWith(body: unknown) {
  return new Request("http://localhost/api/agent-config/verify", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function grantAccess() {
  mocked.requireWorkspaceAccessById.mockResolvedValueOnce({
    ok: true,
    context: {
      currentMember: { id: "m1", role: "owner", is_active: true, kind: "human" },
      workspace: { id: WORKSPACE_ID, name: "wallie", slug: "wallie" },
      user: { id: USER_ID },
    },
  });
}

function mockSecretRow(value: { encrypted_value: string } | null) {
  mocked.createSupabaseAdminClient.mockReturnValueOnce({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: value, error: null }),
          }),
        }),
      }),
    }),
  });
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("POST /api/agent-config/verify — provider/model mismatches", () => {
  it("rejects gpt-* models when provider is anthropic_api before any network call", async () => {
    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "anthropic_api", model: "gpt-5-codex" }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/claude-/);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
  });

  it("rejects claude-* models when provider is codex", async () => {
    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "codex", model: "claude-sonnet-4-5" }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/gpt-/);
  });

  it("rejects garbage model strings before access lookup", async () => {
    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "codex", model: "lol" }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean };
    expect(payload.ok).toBe(false);
  });
});

describe("POST /api/agent-config/verify — anthropic", () => {
  it("returns 200 ok:false when ANTHROPIC_API_KEY is missing", async () => {
    grantAccess();
    mockSecretRow(null);

    const response = await POST(
      postWith({
        workspaceId: WORKSPACE_ID,
        provider: "anthropic_api",
        model: "claude-sonnet-4-5",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("returns ok:true when Anthropic responds 200", async () => {
    grantAccess();
    mockSecretRow({ encrypted_value: "ENC" });
    mocked.decryptSecretValue.mockReturnValue("sk-ant-test");
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "msg" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const response = await POST(
      postWith({
        workspaceId: WORKSPACE_ID,
        provider: "anthropic_api",
        model: "claude-sonnet-4-5",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "sk-ant-test" }),
      }),
    );
  });

  it("surfaces the Anthropic error message on a 401", async () => {
    grantAccess();
    mockSecretRow({ encrypted_value: "ENC" });
    mocked.decryptSecretValue.mockReturnValue("sk-ant-bad");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { type: "authentication_error", message: "invalid x-api-key" } }),
          { status: 401 },
        ),
    ) as unknown as typeof fetch;

    const response = await POST(
      postWith({
        workspaceId: WORKSPACE_ID,
        provider: "anthropic_api",
        model: "claude-sonnet-4-5",
      }),
    );

    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("invalid x-api-key");
  });
});

describe("POST /api/agent-config/verify — claude_code (sandbox CLI)", () => {
  it("returns ok:'skipped' without touching ANTHROPIC_API_KEY or the access check", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const response = await POST(
      postWith({
        workspaceId: WORKSPACE_ID,
        provider: "claude_code",
        model: "claude-sonnet-4-5",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: unknown; reason?: string };
    expect(payload.ok).toBe("skipped");
    expect(payload.reason).toMatch(/sandbox/i);
    expect(mocked.requireWorkspaceAccessById).not.toHaveBeenCalled();
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("still rejects model/provider mismatches before skipping", async () => {
    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "claude_code", model: "gpt-5-codex" }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: unknown; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/claude-/);
  });
});

describe("POST /api/agent-config/verify — codex", () => {
  it("explains when Codex isn't connected", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce({});
    mocked.getCodexAccessTokenForUser.mockRejectedValue(
      new mocked.CodexNotConnectedError("not connected"),
    );

    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "codex", model: "gpt-5-codex" }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Connect your Codex account/);
  });

  it("returns ok:true when the Codex backend accepts the call", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce({});
    mocked.getCodexAccessTokenForUser.mockResolvedValue("oauth-token");
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "resp" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "codex", model: "gpt-5-codex" }),
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer oauth-token" }),
      }),
    );
  });
});
