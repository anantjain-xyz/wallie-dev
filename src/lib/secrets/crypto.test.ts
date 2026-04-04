import { describe, expect, it } from "vitest";

import { buildSecretPreview, decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";

const testEnv = {
  WALLIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
};

describe("secret encryption", () => {
  it("round-trips encrypted secret values", () => {
    const encrypted = encryptSecretValue("super-secret-value", testEnv);

    expect(encrypted).not.toContain("super-secret-value");
    expect(decryptSecretValue(encrypted, testEnv)).toBe("super-secret-value");
  });

  it("rejects malformed encrypted payloads", () => {
    expect(() => decryptSecretValue("not-a-secret", testEnv)).toThrow(
      "Encrypted secret payload is invalid.",
    );
  });
});

describe("secret previews", () => {
  it("keeps only the trailing portion of long secrets", () => {
    expect(buildSecretPreview("anthropic-secret-value")).toBe("...-value");
  });

  it("returns the whole value for short secrets and null for empty input", () => {
    expect(buildSecretPreview("abcd")).toBe("abcd");
    expect(buildSecretPreview("   ")).toBeNull();
  });
});
