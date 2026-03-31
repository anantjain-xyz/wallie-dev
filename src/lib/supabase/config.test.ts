import { describe, expect, it } from "vitest";

import {
  resolveSupabaseAdminConfig,
  resolveSupabasePublicConfig,
} from "@/lib/supabase/config";

const publicEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
};

const adminEnv = {
  ...publicEnv,
  SUPABASE_SECRET_KEY: "secret-key",
  WALLIE_ENCRYPTION_KEY: "12345678901234567890123456789012",
};

describe("supabase config resolvers", () => {
  it("resolves the public config from env", () => {
    expect(resolveSupabasePublicConfig(publicEnv)).toEqual({
      publishableKey: "publishable-key",
      url: "https://example.supabase.co",
    });
  });

  it("resolves the admin config from env", () => {
    expect(resolveSupabaseAdminConfig(adminEnv)).toEqual({
      publishableKey: "publishable-key",
      secretKey: "secret-key",
      url: "https://example.supabase.co",
    });
  });
});
