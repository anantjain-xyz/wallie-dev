import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  auth: {
    getClaims: vi.fn(),
  },
  cookieOptions: null as null | {
    getAll: () => { name: string; value: string }[];
    setAll: (cookies: { name: string; options?: object; value: string }[]) => void;
  },
  createServerClient: vi.fn(),
  responses: [] as { cookies: { set: ReturnType<typeof vi.fn> } }[],
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: mocked.createServerClient,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => {
      const response = { cookies: { set: vi.fn() } };
      mocked.responses.push(response);
      return response;
    }),
  },
}));

import { updateSupabaseSession } from "@/lib/supabase/middleware";

function createRequest(cookieNames = ["sb-example-auth-token"]) {
  const values = new Map(cookieNames.map((name) => [name, "cookie-value"]));

  return {
    cookies: {
      delete: vi.fn((name: string) => values.delete(name)),
      getAll: vi.fn(() => [...values].map(([name, value]) => ({ name, value }))),
      set: vi.fn((name: string, value: string) => values.set(name, value)),
    },
  };
}

describe("Supabase session middleware", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("WALLIE_TIMING_LOGS", "0");
    mocked.auth.getClaims.mockReset();
    mocked.cookieOptions = null;
    mocked.responses.length = 0;
    mocked.createServerClient.mockReset();
    mocked.createServerClient.mockImplementation((_url, _key, options) => {
      mocked.cookieOptions = options.cookies;
      return { auth: mocked.auth };
    });
  });

  it("skips auth verification when no session cookie exists", async () => {
    const request = createRequest([]);

    await updateSupabaseSession(request as never);

    expect(mocked.createServerClient).not.toHaveBeenCalled();
    expect(mocked.auth.getClaims).not.toHaveBeenCalled();
  });

  it("accepts asymmetric verified claims without an auth user request", async () => {
    mocked.auth.getClaims.mockResolvedValue({
      data: {
        claims: { sub: "user-123" },
        header: { alg: "ES256", kid: "signing-key" },
      },
      error: null,
    });
    const request = createRequest();

    await updateSupabaseSession(request as never);

    expect(mocked.auth.getClaims).toHaveBeenCalledTimes(1);
    expect(request.cookies.delete).not.toHaveBeenCalled();
  });

  it("propagates refreshed cookies before continuing", async () => {
    mocked.auth.getClaims.mockImplementation(async () => {
      mocked.cookieOptions?.setAll([
        {
          name: "sb-example-auth-token",
          options: { httpOnly: true },
          value: "refreshed-session",
        },
      ]);
      return {
        data: {
          claims: { sub: "user-123" },
          header: { alg: "ES256", kid: "signing-key" },
        },
        error: null,
      };
    });
    const request = createRequest();

    const response = await updateSupabaseSession(request as never);

    expect(request.cookies.set).toHaveBeenCalledWith("sb-example-auth-token", "refreshed-session");
    expect(response.cookies.set).toHaveBeenCalledWith(
      "sb-example-auth-token",
      "refreshed-session",
      { httpOnly: true },
    );
  });

  it.each([
    ["expired", { message: "JWT has expired", name: "AuthInvalidJwtError" }],
    ["malformed", { message: "Invalid JWT structure", name: "AuthInvalidJwtError" }],
    ["invalid", { message: "Invalid JWT signature", name: "AuthInvalidJwtError" }],
  ])("clears auth cookies for an %s token", async (_variant, error) => {
    mocked.auth.getClaims.mockResolvedValue({ data: null, error });
    const request = createRequest(["sb-example-auth-token", "sb-example-auth-token-code-verifier"]);

    const response = await updateSupabaseSession(request as never);

    expect(request.cookies.delete).toHaveBeenCalledWith("sb-example-auth-token");
    expect(request.cookies.delete).toHaveBeenCalledWith("sb-example-auth-token-code-verifier");
    expect(response.cookies.set).toHaveBeenCalledWith("sb-example-auth-token", "", {
      maxAge: 0,
      path: "/",
    });
  });

  it("records the auth-user request used by symmetric verification", async () => {
    vi.stubEnv("WALLIE_TIMING_LOGS", "1");
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    mocked.auth.getClaims.mockResolvedValue({
      data: {
        claims: { sub: "user-123" },
        header: { alg: "HS256" },
      },
      error: null,
    });

    await updateSupabaseSession(createRequest() as never);

    expect(consoleInfo).toHaveBeenCalledWith(
      "[auth-verification]",
      expect.objectContaining({
        authUserRequests: 1,
        claimsVerifications: 0,
        method: "auth-user",
      }),
    );
    consoleInfo.mockRestore();
  });
});
