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
  getOpenCodeCredentialForSession,
  getOpenCodeCredentialForUser,
  OpenCodeNotConnectedError,
} from "@/lib/opencode/tokens";

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

describe("OpenCode credentials", () => {
  it("returns a decrypted Zen API key", async () => {
    const credential = await getOpenCodeCredentialForUser(
      adminWithCredential({ encrypted_api_key: "encrypted:zen-test-key" }),
      "user-1",
    );

    expect(credential).toEqual({ secret: "zen-test-key" });
  });

  it("throws a clear not-connected error when no key exists", async () => {
    await expect(getOpenCodeCredentialForUser(adminWithCredential(null), "user-1")).rejects.toThrow(
      OpenCodeNotConnectedError,
    );
  });

  it("resolves the session creator before loading the key", async () => {
    mocked.resolveSessionOwnerUserId.mockResolvedValueOnce("owner-1");
    const admin = adminWithCredential({ encrypted_api_key: "encrypted:zen-owner-key" });

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
      getOpenCodeCredentialForSession(adminWithCredential(null), {
        creator_member_id: null,
      }),
    ).rejects.toThrow(/Session has no human owner/);
  });
});
