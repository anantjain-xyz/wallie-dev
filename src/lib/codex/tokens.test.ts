import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

import { CodexNotConnectedError, getCodexCredentialForUser } from "@/lib/codex/tokens";

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
});
