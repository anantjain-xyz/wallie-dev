import { describe, expect, it } from "vitest";

import {
  resolveSupabaseAdminConfig,
  resolveSupabasePublicConfig,
} from "@/lib/supabase/config";

const publicEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
};

const adminEnv = {
  ...publicEnv,
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  WALLIE_ENCRYPTION_KEY: "12345678901234567890123456789012",
};

describe("supabase config resolvers", () => {
  it("resolves the public config from env", () => {
    expect(resolveSupabasePublicConfig(publicEnv)).toEqual({
      anonKey: "anon-key",
      url: "https://example.supabase.co",
    });
  });

  it("resolves the admin config from env", () => {
    expect(resolveSupabaseAdminConfig(adminEnv)).toEqual({
      anonKey: "anon-key",
      serviceRoleKey: "service-role-key",
      url: "https://example.supabase.co",
    });
  });
});
