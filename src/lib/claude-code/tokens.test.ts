import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  decryptSecretValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
}));

vi.mock("@/lib/secrets/crypto", () => ({
  decryptSecretValue: mocked.decryptSecretValue,
}));

import {
  ClaudeCodeNotConnectedError,
  getClaudeCodeCredentialForUser,
} from "@/lib/claude-code/tokens";

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

describe("getClaudeCodeCredentialForUser", () => {
  it("returns a decrypted Anthropic API key", async () => {
    const credential = await getClaudeCodeCredentialForUser(
      adminWithCredential({ encrypted_api_key: "encrypted:sk-ant-test" }),
      "user-1",
    );

    expect(credential).toEqual({ secret: "sk-ant-test" });
  });

  it("throws a not-connected error when no credential exists", async () => {
    await expect(
      getClaudeCodeCredentialForUser(adminWithCredential(null), "user-1"),
    ).rejects.toThrow(ClaudeCodeNotConnectedError);
  });
});
