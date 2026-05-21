import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  class CodexNotConnectedErrorMock extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CodexNotConnectedError";
    }
  }
  class ClaudeCodeNotConnectedErrorMock extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ClaudeCodeNotConnectedError";
    }
  }
  return {
    createSupabaseAdminClient: vi.fn(),
    requireWorkspaceAccessById: vi.fn(),
    getCodexCredentialForUser: vi.fn(),
    getClaudeCodeCredentialForUser: vi.fn(),
    CodexNotConnectedError: CodexNotConnectedErrorMock,
    ClaudeCodeNotConnectedError: ClaudeCodeNotConnectedErrorMock,
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/workspaces/access", () => ({
  requireWorkspaceAccessById: mocked.requireWorkspaceAccessById,
}));

vi.mock("@/lib/codex/tokens", () => ({
  getCodexCredentialForUser: mocked.getCodexCredentialForUser,
  CodexNotConnectedError: mocked.CodexNotConnectedError,
}));

vi.mock("@/lib/claude-code/tokens", () => ({
  getClaudeCodeCredentialForUser: mocked.getClaudeCodeCredentialForUser,
  ClaudeCodeNotConnectedError: mocked.ClaudeCodeNotConnectedError,
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

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("POST /api/agent-config/verify — provider/model mismatches", () => {
  it("rejects removed providers before any access lookup", async () => {
    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "openai", model: "gpt-5.5" }),
    );

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Provider must be one of: codex, claude-code/);
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

describe("POST /api/agent-config/verify — claude-code (sandbox CLI)", () => {
  it("returns ok:'skipped' when an Anthropic API key is connected", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce({});
    mocked.getClaudeCodeCredentialForUser.mockResolvedValue({ secret: "sk-ant-test" });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const response = await POST(
      postWith({
        workspaceId: WORKSPACE_ID,
        provider: "claude-code",
        model: "claude-opus-4-7[1m]",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: unknown; reason?: string };
    expect(payload.ok).toBe("skipped");
    expect(payload.reason).toMatch(/Claude Code CLI/);
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalledWith(WORKSPACE_ID, {
      requireManager: true,
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("still rejects model/provider mismatches before skipping", async () => {
    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "claude-code", model: "gpt-5-codex" }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: unknown; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/claude-/);
  });

  it("normalizes the legacy claude_code alias before dispatch", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce({});
    mocked.getClaudeCodeCredentialForUser.mockResolvedValue({ secret: "sk-ant-test" });
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
    expect(mocked.requireWorkspaceAccessById).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("explains when an Anthropic API key isn't connected", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce({});
    mocked.getClaudeCodeCredentialForUser.mockRejectedValue(
      new mocked.ClaudeCodeNotConnectedError("not connected"),
    );

    const response = await POST(
      postWith({
        workspaceId: WORKSPACE_ID,
        provider: "claude-code",
        model: "claude-opus-4-7[1m]",
      }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Connect an Anthropic API key/);
  });
});

describe("POST /api/agent-config/verify — codex", () => {
  it("explains when Codex isn't connected", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce({});
    mocked.getCodexCredentialForUser.mockRejectedValue(
      new mocked.CodexNotConnectedError("not connected"),
    );

    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "codex", model: "gpt-5.5" }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Connect a Codex credential/);
  });

  it("returns ok:'skipped' for Codex access tokens", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce({});
    mocked.getCodexCredentialForUser.mockResolvedValue({
      expiresAt: null,
      secret: "codex-token",
      type: "codex_access_token",
    });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "codex", model: "gpt-5.5" }),
    );

    const payload = (await response.json()) as { ok: unknown; reason?: string };
    expect(payload.ok).toBe("skipped");
    expect(payload.reason).toMatch(/Codex CLI/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("returns ok:true when the official Responses API accepts a platform API key", async () => {
    grantAccess();
    mocked.createSupabaseAdminClient.mockReturnValueOnce({});
    mocked.getCodexCredentialForUser.mockResolvedValue({
      expiresAt: null,
      secret: "sk-test",
      type: "platform_api_key",
    });
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ id: "resp" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const response = await POST(
      postWith({ workspaceId: WORKSPACE_ID, provider: "codex", model: "gpt-5.5" }),
    );

    expect(await response.json()).toEqual({ ok: true });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        body: JSON.stringify({
          model: "gpt-5.5",
          input: "Reply with the single word: ok.",
          max_output_tokens: 16,
          store: false,
        }),
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer sk-test" }),
      }),
    );
  });
});
