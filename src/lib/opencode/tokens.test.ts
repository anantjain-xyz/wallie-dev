import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
  resolveSessionOwnerUserId: vi.fn(),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

vi.mock("@/lib/agent-credentials/session-owner", () => ({
  resolveSessionOwnerUserId: mocked.resolveSessionOwnerUserId,
}));

import {
  getOpenCodeAuthForSession,
  getOpenCodeAuthForUser,
  getOpenCodeCredentialForSession,
  getOpenCodeCredentialForUser,
  listOpenCodeProviderCredentialMeta,
  OpenCodeNotConnectedError,
} from "@/lib/opencode/tokens";

function adminWithRows(rows: Record<string, unknown>) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => {
          const result = { data: rows[table] ?? null, error: null };
          return {
            eq: () => ({
              maybeSingle: async () => result,
            }),
            maybeSingle: async () => result,
            order: async () => ({
              data: Array.isArray(rows[table]) ? rows[table] : [],
              error: null,
            }),
          };
        },
      }),
    }),
  } as never;
}

describe("OpenCode credentials", () => {
  it("returns a decrypted Zen API key", async () => {
    const credential = await getOpenCodeCredentialForUser(
      adminWithRows({
        user_opencode_credentials: { encrypted_api_key: "encrypted:zen-test-key" },
      }),
      "user-1",
    );

    expect(credential).toEqual({ secret: "zen-test-key" });
  });

  it("throws a clear not-connected error when no key exists", async () => {
    await expect(getOpenCodeCredentialForUser(adminWithRows({}), "user-1")).rejects.toThrow(
      OpenCodeNotConnectedError,
    );
  });

  it("resolves the session creator before loading the key", async () => {
    mocked.resolveSessionOwnerUserId.mockResolvedValueOnce("owner-1");
    const admin = adminWithRows({
      user_opencode_credentials: { encrypted_api_key: "encrypted:zen-owner-key" },
    });

    await expect(
      getOpenCodeCredentialForSession(admin, { creator_member_id: "member-1" }),
    ).resolves.toEqual({ secret: "zen-owner-key" });
    expect(mocked.resolveSessionOwnerUserId).toHaveBeenCalledWith(admin, {
      creator_member_id: "member-1",
    });
  });

  it("rejects sessions without a human owner", async () => {
    mocked.resolveSessionOwnerUserId.mockResolvedValueOnce(null);

    await expect(
      getOpenCodeCredentialForSession(adminWithRows({}), {
        creator_member_id: null,
      }),
    ).rejects.toThrow(/Session has no human owner/);
  });
});

describe("OpenCode per-provider auth", () => {
  it("loads the Zen key for opencode/* models", async () => {
    const auth = await getOpenCodeAuthForUser(
      adminWithRows({
        user_opencode_credentials: { encrypted_api_key: "encrypted:zen-test-key" },
      }),
      "user-1",
      "opencode/gpt-5.6-sol",
    );

    expect(auth).toEqual({
      credential: { secret: "zen-test-key" },
      providerCredentials: {},
    });
  });

  it("loads the matching custom provider key and optional Zen key", async () => {
    const auth = await getOpenCodeAuthForUser(
      adminWithRows({
        user_opencode_credentials: { encrypted_api_key: "encrypted:zen-test-key" },
        user_opencode_provider_credentials: { encrypted_api_key: "encrypted:go-key" },
      }),
      "user-1",
      "opencode-go/glm-5.3",
    );

    expect(auth).toEqual({
      credential: { secret: "zen-test-key" },
      providerCredentials: { "opencode-go": { secret: "go-key" } },
    });
  });

  it("runs a custom provider without a Zen key", async () => {
    const auth = await getOpenCodeAuthForUser(
      adminWithRows({
        user_opencode_provider_credentials: { encrypted_api_key: "encrypted:go-key" },
      }),
      "user-1",
      "opencode-go/glm-5.3",
    );

    expect(auth).toEqual({
      credential: null,
      providerCredentials: { "opencode-go": { secret: "go-key" } },
    });
  });

  it("fails fast when a custom provider has no stored key", async () => {
    await expect(
      getOpenCodeAuthForUser(
        adminWithRows({
          user_opencode_credentials: { encrypted_api_key: "encrypted:zen-test-key" },
        }),
        "user-1",
        "opencode-go/glm-5.3",
      ),
    ).rejects.toThrow(/OpenCode provider "opencode-go" is not connected/);
  });

  it("rejects invalid model ids before looking up credentials", async () => {
    await expect(
      getOpenCodeAuthForUser(adminWithRows({}), "user-1", "gpt-5.6-sol"),
    ).rejects.toThrow(/not a valid "<provider-id>\/<model-id>" identifier/);
  });

  it("resolves session auth from the session owner", async () => {
    mocked.resolveSessionOwnerUserId.mockResolvedValueOnce("owner-1");
    const admin = adminWithRows({
      user_opencode_provider_credentials: { encrypted_api_key: "encrypted:go-owner-key" },
    });

    await expect(
      getOpenCodeAuthForSession(admin, { creator_member_id: "member-1" }, "opencode-go/glm-5.3"),
    ).resolves.toEqual({
      credential: null,
      providerCredentials: { "opencode-go": { secret: "go-owner-key" } },
    });
  });

  it("lists provider credential metadata without secrets", async () => {
    const providers = await listOpenCodeProviderCredentialMeta(
      adminWithRows({
        user_opencode_provider_credentials: [
          { provider_id: "opencode-go", updated_at: "2026-09-01T00:00:00.000Z" },
        ],
      }),
      "user-1",
    );

    expect(providers).toEqual([
      { providerId: "opencode-go", updatedAt: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(JSON.stringify(providers)).not.toContain("encrypted");
  });
});
