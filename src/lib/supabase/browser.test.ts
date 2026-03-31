import { describe, expect, it, vi } from "vitest";

const mockCreateBrowserClient = vi.hoisted(() =>
  vi.fn(() => ({ client: "browser" })),
);

vi.mock("@supabase/ssr", () => ({
  createBrowserClient: mockCreateBrowserClient,
}));

import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

describe("createSupabaseBrowserClient", () => {
  it("passes the resolved public config to Supabase", () => {
    const client = createSupabaseBrowserClient({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    });

    expect(mockCreateBrowserClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key",
    );
    expect(client).toEqual({ client: "browser" });
  });
});
