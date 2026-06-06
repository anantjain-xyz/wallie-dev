import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/env/server";

const validEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "secret-key",
  WALLIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("parseServerEnv", () => {
  it("accepts the scaffolded required environment variables", () => {
    expect(parseServerEnv(validEnv)).toMatchObject(validEnv);
  });

  it("treats blank optional integration env values as missing", () => {
    const parsed = parseServerEnv({
      ...validEnv,
      GITHUB_APP_ID: "",
      GITHUB_APP_CLIENT_ID: "",
      GITHUB_APP_CLIENT_SECRET: "",
      GITHUB_APP_PRIVATE_KEY: "",
      GITHUB_WEBHOOK_SECRET: "",
    });

    expect(parsed.GITHUB_APP_ID).toBeUndefined();
    expect(parsed.GITHUB_APP_CLIENT_ID).toBeUndefined();
    expect(parsed.GITHUB_APP_CLIENT_SECRET).toBeUndefined();
    expect(parsed.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(parsed.GITHUB_WEBHOOK_SECRET).toBeUndefined();
  });

  it("rejects short encryption keys", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        WALLIE_ENCRYPTION_KEY: "short",
      }),
    ).toThrow();
  });

  it("rejects 32-character human-typed phrases that are not hex or base64", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        WALLIE_ENCRYPTION_KEY: "this is my super secret pass!!!!",
      }),
    ).toThrow(/hex-encoded|base64-encoded/);
  });

  it("rejects 32-hex-char keys (only 16 bytes of entropy)", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        WALLIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
      }),
    ).toThrow();
  });

  it("accepts a base64-encoded 32-byte key", () => {
    expect(
      parseServerEnv({
        ...validEnv,
        WALLIE_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
      }).WALLIE_ENCRYPTION_KEY,
    ).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
  });
});
