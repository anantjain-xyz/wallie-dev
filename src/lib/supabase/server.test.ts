import { describe, expect, it, vi } from "vitest";

const mockCreateServerClient = vi.hoisted(() =>
  vi.fn(() => ({ client: "server" })),
);

vi.mock("@supabase/ssr", () => ({
  createServerClient: mockCreateServerClient,
}));

import { createSupabaseServerClient, toSupabaseCookieValues } from "@/lib/supabase/server";

describe("supabase server helpers", () => {
  it("passes the resolved public config and cookie adapter to Supabase", async () => {
    const cookieStore = {
      getAll: () => [{ name: "sb", value: "token" }],
      set: vi.fn(),
      delete: vi.fn(),
    };

    const client = await createSupabaseServerClient(
      {
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
        NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      },
      cookieStore,
    );

    expect(mockCreateServerClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key",
      {
        cookies: {
          getAll: expect.any(Function),
          setAll: expect.any(Function),
        },
      },
    );
    expect(client).toEqual({ client: "server" });
  });

  it("strips cookie options down to name/value pairs when needed", () => {
    expect(
      toSupabaseCookieValues([
        {
          name: "sb",
          options: { path: "/" },
          value: "token",
        },
      ]),
    ).toEqual([{ name: "sb", value: "token" }]);
  });
});
