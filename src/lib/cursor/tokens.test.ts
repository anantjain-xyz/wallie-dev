import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

import { CursorNotConnectedError, getCursorCredentialForUser } from "@/lib/cursor/tokens";

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

describe("getCursorCredentialForUser", () => {
  it("returns an unexpired decrypted Cursor key", async () => {
    const credential = await getCursorCredentialForUser(
      adminWithCredential({
        api_key_expires_at: "2099-01-01T00:00:00.000Z",
        encrypted_api_key: "encrypted:cursor-key",
        reconnect_reason: null,
        reconnect_required: false,
      }),
      "user-1",
    );
    expect(credential).toEqual({
      expiresAt: "2099-01-01T00:00:00.000Z",
      secret: "cursor-key",
      userId: "user-1",
    });
  });

  it("requires reconnect for expired or rejected credentials", async () => {
    await expect(
      getCursorCredentialForUser(
        adminWithCredential({
          api_key_expires_at: "2020-01-01T00:00:00.000Z",
          encrypted_api_key: "encrypted:cursor-key",
          reconnect_reason: null,
          reconnect_required: false,
        }),
        "user-1",
      ),
    ).rejects.toThrow(CursorNotConnectedError);

    await expect(
      getCursorCredentialForUser(
        adminWithCredential({
          api_key_expires_at: "2099-01-01T00:00:00.000Z",
          encrypted_api_key: "encrypted:cursor-key",
          reconnect_reason: "Reconnect Cursor.",
          reconnect_required: true,
        }),
        "user-1",
      ),
    ).rejects.toThrow("Reconnect Cursor.");
  });
});
