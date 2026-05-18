import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { buildSecretPreview, decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";

const testEnv = {
  WALLIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

function buildLegacyV1Payload(plaintext: string, secret: string) {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(".");
}

describe("secret encryption", () => {
  it("round-trips encrypted secret values and tags new payloads as v2", () => {
    const encrypted = encryptSecretValue("super-secret-value", testEnv);

    expect(encrypted.startsWith("v2.")).toBe(true);
    expect(encrypted).not.toContain("super-secret-value");
    expect(decryptSecretValue(encrypted, testEnv)).toBe("super-secret-value");
  });

  it("decrypts legacy v1 payloads written by the SHA-256 derivation", () => {
    const legacy = buildLegacyV1Payload("legacy-value", testEnv.WALLIE_ENCRYPTION_KEY);

    expect(legacy.startsWith("v1.")).toBe(true);
    expect(decryptSecretValue(legacy, testEnv)).toBe("legacy-value");
  });

  it("derives a different key for v2 than v1 so v1 ciphertext cannot decrypt under v2", () => {
    const legacy = buildLegacyV1Payload("legacy-value", testEnv.WALLIE_ENCRYPTION_KEY);
    const forgedAsV2 = `v2.${legacy.slice("v1.".length)}`;

    expect(() => decryptSecretValue(forgedAsV2, testEnv)).toThrow();
  });

  it("rejects malformed encrypted payloads", () => {
    expect(() => decryptSecretValue("not-a-secret", testEnv)).toThrow(
      "Encrypted secret payload is invalid.",
    );
  });

  it("rejects unknown version prefixes", () => {
    const encrypted = encryptSecretValue("value", testEnv);
    const tampered = `v9.${encrypted.slice("v2.".length)}`;

    expect(() => decryptSecretValue(tampered, testEnv)).toThrow(
      "Encrypted secret payload is invalid.",
    );
  });
});

describe("secret previews", () => {
  it("keeps only the trailing portion of long secrets", () => {
    expect(buildSecretPreview("provider-secret-value")).toBe("...-value");
  });

  it("returns the whole value for short secrets and null for empty input", () => {
    expect(buildSecretPreview("abcd")).toBe("abcd");
    expect(buildSecretPreview("   ")).toBeNull();
  });
});
