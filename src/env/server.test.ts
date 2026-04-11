import { describe, expect, it } from "vitest";

import { parseServerEnv } from "@/env/server";

const validEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "secret-key",
  WALLIE_ENCRYPTION_KEY: "12345678901234567890123456789012",
};

describe("parseServerEnv", () => {
  it("accepts the scaffolded required environment variables", () => {
    expect(parseServerEnv(validEnv)).toMatchObject(validEnv);
  });

  it("treats blank optional integration env values as missing", () => {
    const parsed = parseServerEnv({
      ...validEnv,
      GITHUB_APP_ID: "",
      GITHUB_APP_PRIVATE_KEY: "",
      GITHUB_WEBHOOK_SECRET: "",
      WALLIE_PROCESS_TOKEN: "",
    });

    expect(parsed.GITHUB_APP_ID).toBeUndefined();
    expect(parsed.GITHUB_APP_PRIVATE_KEY).toBeUndefined();
    expect(parsed.GITHUB_WEBHOOK_SECRET).toBeUndefined();
    expect(parsed.WALLIE_PROCESS_TOKEN).toBeUndefined();
  });

  it("rejects short encryption keys", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv,
        WALLIE_ENCRYPTION_KEY: "short",
      }),
    ).toThrow();
  });
});
