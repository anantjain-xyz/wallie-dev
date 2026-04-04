import { describe, expect, it, vi } from "vitest";

const mockCreateServerClient = vi.hoisted(() => vi.fn(() => ({ client: "server" })));

vi.mock("@supabase/ssr", () => ({
  createServerClient: mockCreateServerClient,
}));

import { createSupabaseServerClient, toSupabaseCookieValues } from "@/lib/supabase/server";

const publicSupabaseEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
};

type CookieAdapterValue = {
  name: string;
  options?: object;
  value: string;
};

type SupabaseCookieAdapter = {
  cookies: {
    getAll: () => { name: string; value: string }[];
    setAll: (cookiesToSet: CookieAdapterValue[]) => void;
  };
};

function getSupabaseCookieAdapter() {
  const lastCall = mockCreateServerClient.mock.calls.at(-1) as unknown[] | undefined;
  const options = lastCall?.[2] as SupabaseCookieAdapter | undefined;

  expect(options).toBeDefined();

  return options!.cookies;
}

describe("supabase server helpers", () => {
  it("passes the resolved public config and cookie adapter to Supabase", async () => {
    const cookieStore = {
      getAll: () => [{ name: "sb", value: "token" }],
      set: vi.fn(),
      delete: vi.fn(),
    };

    const client = await createSupabaseServerClient(publicSupabaseEnv, cookieStore);

    expect(mockCreateServerClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "publishable-key",
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

  it("retries cookie writes without options when the store rejects the third arg", async () => {
    const set = vi.fn((name: string, value: string, options?: object) => {
      if (options) {
        throw new Error("options unsupported");
      }
    });
    const cookieStore = {
      getAll: () => [],
      set,
    };

    await createSupabaseServerClient(publicSupabaseEnv, cookieStore);

    const cookies = getSupabaseCookieAdapter();

    expect(() =>
      cookies.setAll([
        {
          name: "sb",
          options: { path: "/" },
          value: "token",
        },
      ]),
    ).not.toThrow();

    expect(set).toHaveBeenNthCalledWith(1, "sb", "token", { path: "/" });
    expect(set).toHaveBeenNthCalledWith(2, "sb", "token");
  });

  it("swallows cookie writes when the store is read-only", async () => {
    const cookieStore = {
      getAll: () => [],
      set: vi.fn(() => {
        throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      }),
    };

    await createSupabaseServerClient(publicSupabaseEnv, cookieStore);

    const cookies = getSupabaseCookieAdapter();

    expect(() =>
      cookies.setAll([
        {
          name: "sb",
          options: { path: "/" },
          value: "token",
        },
      ]),
    ).not.toThrow();

    expect(cookieStore.set).toHaveBeenCalledTimes(1);
  });

  it("rethrows unexpected cookie write errors", async () => {
    const cookieStore = {
      getAll: () => [],
      set: vi.fn(() => {
        throw new Error("unexpected cookie failure");
      }),
    };

    await createSupabaseServerClient(publicSupabaseEnv, cookieStore);

    const cookies = getSupabaseCookieAdapter();

    expect(() =>
      cookies.setAll([
        {
          name: "sb",
          options: { path: "/" },
          value: "token",
        },
      ]),
    ).toThrow("unexpected cookie failure");
  });
});
