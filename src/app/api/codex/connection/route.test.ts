import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createSupabaseAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
  encryptSecretValue: vi.fn((value: string) => `encrypted:${value}`),
  getSupabaseUserOrNull: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: mocked.createSupabaseAdminClient,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocked.createSupabaseServerClient,
}));

vi.mock("@/lib/supabase/auth", () => ({
  getSupabaseUserOrNull: mocked.getSupabaseUserOrNull,
}));

vi.mock("@/lib/secrets/crypto", () => ({
  encryptSecretValue: mocked.encryptSecretValue,
}));

import { DELETE, GET, POST } from "./route";

const USER_ID = "user-1";

function request(body: unknown) {
  return new Request("http://localhost/api/codex/connection", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.createSupabaseServerClient.mockResolvedValue({});
  mocked.getSupabaseUserOrNull.mockResolvedValue({ id: USER_ID });
});

describe("/api/codex/connection", () => {
  it("returns disconnected status when no credential is saved", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: false });
  });

  it("returns saved credential metadata without returning the secret", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        access_token_expires_at: null,
        account_email: null,
        auth_cache_last_refresh: null,
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: "platform_api_key",
        updated_at: "2026-05-18T00:00:00.000Z",
      },
      error: null,
    });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });

    const response = await GET();

    expect(await response.json()).toEqual({
      accountEmail: null,
      authCacheLastRefresh: null,
      connected: true,
      credentialType: "platform_api_key",
      expired: false,
      expiresAt: null,
      reconnectReason: null,
      reconnectRequired: false,
      updatedAt: "2026-05-18T00:00:00.000Z",
    });
  });

  it("marks expired saved credentials as disconnected", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        access_token_expires_at: "2000-01-01T00:00:00.000Z",
        account_email: null,
        auth_cache_last_refresh: null,
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: "codex_access_token",
        updated_at: "2026-05-18T00:00:00.000Z",
      },
      error: null,
    });
    mocked.createSupabaseAdminClient.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    });

    const response = await GET();

    expect(await response.json()).toMatchObject({
      connected: false,
      credentialType: "codex_access_token",
      expired: true,
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
  });

  it("saves a platform API key as one encrypted credential", async () => {
    const single = vi.fn().mockResolvedValue({
      data: {
        access_token_expires_at: null,
        account_email: null,
        auth_cache_last_refresh: null,
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: "platform_api_key",
        updated_at: "2026-05-18T00:00:00.000Z",
      },
      error: null,
    });
    const select = vi.fn(() => ({ single }));
    const upsert = vi.fn(() => ({ select }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ upsert }) });

    const response = await POST(
      request({
        credential: "sk-proj-abcdefghijklmnopqrstuvwxyz",
        credentialType: "platform_api_key",
      }),
    );

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token_expires_at: null,
        auth_cache_last_refresh: null,
        auth_lock_expires_at: null,
        auth_lock_run_id: null,
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: "platform_api_key",
        credential_version: 1,
        encrypted_credential: "encrypted:sk-proj-abcdefghijklmnopqrstuvwxyz",
        user_id: USER_ID,
      }),
      { onConflict: "user_id" },
    );
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain("sk-proj");
  });

  it("saves a Codex access token with an optional expiration", async () => {
    const single = vi.fn().mockResolvedValue({
      data: {
        access_token_expires_at: "2099-06-01T00:00:00.000Z",
        account_email: null,
        auth_cache_last_refresh: null,
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: "codex_access_token",
        updated_at: "2026-05-18T00:00:00.000Z",
      },
      error: null,
    });
    const upsert = vi.fn(() => ({ select: () => ({ single }) }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ upsert }) });

    const response = await POST(
      request({
        credential: "codex-access-token-value",
        credentialType: "codex_access_token",
        expiresAt: "2099-06-01T00:00:00.000Z",
      }),
    );

    expect(response.status).toBe(200);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token_expires_at: "2099-06-01T00:00:00.000Z",
        auth_cache_last_refresh: null,
        auth_lock_expires_at: null,
        auth_lock_run_id: null,
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: "codex_access_token",
        credential_version: 1,
        encrypted_credential: "encrypted:codex-access-token-value",
      }),
      { onConflict: "user_id" },
    );
  });

  it("rejects manual ChatGPT auth cache posts", async () => {
    const response = await POST(
      request({
        credential: '{"auth_mode":"chatgpt"}',
        credentialType: "chatgpt_auth_json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Use Sign in with ChatGPT to connect a ChatGPT subscription.",
    });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("rejects malformed API keys", async () => {
    const response = await POST(
      request({ credential: "not-an-openai-api-key", credentialType: "platform_api_key" }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "OpenAI API keys should start with sk-." });
    expect(mocked.createSupabaseAdminClient).not.toHaveBeenCalled();
  });

  it("deletes the current user's saved credential", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const deleteFn = vi.fn(() => ({ eq }));
    mocked.createSupabaseAdminClient.mockReturnValue({ from: () => ({ delete: deleteFn }) });

    const response = await DELETE();

    expect(response.status).toBe(204);
    expect(eq).toHaveBeenCalledWith("user_id", USER_ID);
  });
});
