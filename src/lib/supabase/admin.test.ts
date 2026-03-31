import { describe, expect, it, vi } from "vitest";

const mockCreateClient = vi.hoisted(() =>
  vi.fn(() => ({ client: "admin" })),
);

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

import { createSupabaseAdminClient } from "@/lib/supabase/admin";

describe("createSupabaseAdminClient", () => {
  it("uses the service role key and disables browser auth persistence", () => {
    const client = createSupabaseAdminClient({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      WALLIE_ENCRYPTION_KEY: "12345678901234567890123456789012",
    });

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "service-role-key",
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );
    expect(client).toEqual({ client: "admin" });
  });
});
