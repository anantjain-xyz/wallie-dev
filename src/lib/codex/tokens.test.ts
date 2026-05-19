import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
  encryptSecretValue: vi.fn((value: string) => `encrypted:${value}`),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
  encryptSecretValue: mocked.encryptSecretValue,
}));

import {
  CodexNotConnectedError,
  createCodexChatGptAuthStore,
  getCodexCredentialForUser,
} from "@/lib/codex/tokens";

function adminWithCredential(row: unknown) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: row, error: null }),
        }),
      }),
    }),
  } as never;
}

describe("getCodexCredentialForUser", () => {
  it("returns a typed decrypted credential", async () => {
    const credential = await getCodexCredentialForUser(
      adminWithCredential({
        access_token_expires_at: null,
        credential_type: "platform_api_key",
        encrypted_credential: "encrypted:sk-test",
      }),
      "user-1",
    );

    expect(credential).toEqual({
      expiresAt: null,
      secret: "sk-test",
      type: "platform_api_key",
      userId: "user-1",
    });
  });

  it("returns ChatGPT auth cache metadata", async () => {
    const credential = await getCodexCredentialForUser(
      adminWithCredential({
        access_token_expires_at: null,
        auth_cache_last_refresh: "2026-05-19T00:00:00.000Z",
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: "chatgpt_auth_json",
        credential_version: 3,
        encrypted_credential: 'encrypted:{"auth_mode":"chatgpt"}',
      }),
      "user-1",
    );

    expect(credential).toMatchObject({
      authCacheLastRefresh: "2026-05-19T00:00:00.000Z",
      credentialVersion: 3,
      secret: '{"auth_mode":"chatgpt"}',
      type: "chatgpt_auth_json",
      userId: "user-1",
    });
  });

  it("throws a not-connected error when no credential exists", async () => {
    await expect(getCodexCredentialForUser(adminWithCredential(null), "user-1")).rejects.toThrow(
      CodexNotConnectedError,
    );
  });

  it("throws a not-connected error for expired credentials", async () => {
    await expect(
      getCodexCredentialForUser(
        adminWithCredential({
          access_token_expires_at: "2000-01-01T00:00:00.000Z",
          credential_type: "codex_access_token",
          encrypted_credential: "encrypted:expired",
        }),
        "user-1",
      ),
    ).rejects.toThrow(/expired/);
  });

  it("throws when ChatGPT auth needs reconnection", async () => {
    await expect(
      getCodexCredentialForUser(
        adminWithCredential({
          access_token_expires_at: null,
          auth_cache_last_refresh: null,
          auth_reconnect_reason: "reconnect now",
          auth_reconnect_required: true,
          credential_type: "chatgpt_auth_json",
          credential_version: 1,
          encrypted_credential: "encrypted:{}",
        }),
        "user-1",
      ),
    ).rejects.toThrow(/reconnect now/);
  });
});

describe("createCodexChatGptAuthStore", () => {
  it("acquires and decrypts a ChatGPT auth lease", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        {
          access_token_expires_at: null,
          auth_cache_last_refresh: null,
          auth_reconnect_reason: null,
          auth_reconnect_required: false,
          credential_type: "chatgpt_auth_json",
          credential_version: 2,
          encrypted_credential: 'encrypted:{"auth_mode":"chatgpt"}',
        },
      ],
      error: null,
    });
    const store = createCodexChatGptAuthStore({ rpc } as never);

    const credential = await store.acquireChatGptAuthLease({
      leaseExpiresAt: "2026-05-19T00:05:00.000Z",
      runId: "00000000-0000-0000-0000-000000000001",
      userId: "user-1",
    });

    expect(rpc).toHaveBeenCalledWith("acquire_codex_auth_lease", {
      lease_expires_at: "2026-05-19T00:05:00.000Z",
      target_run_id: "00000000-0000-0000-0000-000000000001",
      target_user_id: "user-1",
    });
    expect(credential).toMatchObject({
      credentialVersion: 2,
      secret: '{"auth_mode":"chatgpt"}',
      type: "chatgpt_auth_json",
      userId: "user-1",
    });
  });

  it("persists refreshed auth JSON through the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ credential_version: 4 }], error: null });
    const store = createCodexChatGptAuthStore({ rpc } as never);

    await expect(
      store.persistChatGptAuthJson({
        authJson: '{"auth_mode":"chatgpt"}',
        metadata: {
          accountEmail: "a@example.com",
          accountId: "acct-1",
          lastRefresh: "2026-05-19T00:00:00.000Z",
        },
        previousCredentialVersion: 3,
        runId: "00000000-0000-0000-0000-000000000001",
        userId: "user-1",
      }),
    ).resolves.toBe(true);

    expect(rpc).toHaveBeenCalledWith("persist_codex_auth_json", {
      new_account_email: "a@example.com",
      new_account_id: "acct-1",
      new_auth_cache_last_refresh: "2026-05-19T00:00:00.000Z",
      new_encrypted_credential: 'encrypted:{"auth_mode":"chatgpt"}',
      previous_credential_version: 3,
      target_run_id: "00000000-0000-0000-0000-000000000001",
      target_user_id: "user-1",
    });
  });
});
