import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSupabaseAdminConfig } from "@/lib/supabase/admin-config";
import { resolveSupabasePublicConfig } from "@/lib/supabase/config";

const publicEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
};

const adminEnv = {
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "secret-key",
};

afterEach(() => vi.unstubAllEnvs());

describe("supabase config resolvers", () => {
  it("reads current process configuration without caching or returning server secrets", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://runtime-a.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "key-a");
    vi.stubEnv("SUPABASE_SECRET_KEY", "private-canary");
    expect(resolveSupabasePublicConfig()).toEqual({
      url: "https://runtime-a.example",
      publishableKey: "key-a",
    });

    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://runtime-b.example");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "key-b");
    expect(resolveSupabasePublicConfig()).toEqual({
      url: "https://runtime-b.example",
      publishableKey: "key-b",
    });
  });

  it("resolves the public config from env", () => {
    expect(resolveSupabasePublicConfig(publicEnv)).toEqual({
      publishableKey: "publishable-key",
      url: "https://example.supabase.co",
    });
  });

  it("does not require NEXT_PUBLIC_APP_URL to resolve Supabase public config", () => {
    expect(
      resolveSupabasePublicConfig({
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      }),
    ).toEqual({
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

  it("ignores unrelated blank integration env placeholders for admin config", () => {
    expect(
      resolveSupabaseAdminConfig({
        ...adminEnv,
        GITHUB_APP_ID: "",
      }),
    ).toEqual({
      publishableKey: "publishable-key",
      secretKey: "secret-key",
      url: "https://example.supabase.co",
    });
  });
});
