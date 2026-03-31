import { describe, expect, it } from "vitest";

import {
  getSupabaseAuthCookieBaseName,
  getSupabaseAuthFlowCookieNames,
  getSupabaseSessionCookieNames,
  getSupabaseUserOrNull,
  isSupabaseInvalidSessionError,
} from "@/lib/supabase/auth";

const publicEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
};

describe("supabase auth helpers", () => {
  it("derives the auth cookie base name from the Supabase host", () => {
    expect(getSupabaseAuthCookieBaseName(publicEnv)).toBe(
      "sb-example-auth-token",
    );
  });

  it("distinguishes session cookies from auth flow cookies", () => {
    const cookies = [
      { name: "sb-example-auth-token", value: "session" },
      { name: "sb-example-auth-token.0", value: "session chunk" },
      { name: "sb-example-auth-token-code-verifier", value: "pkce" },
      { name: "other-cookie", value: "other" },
    ];

    expect(getSupabaseSessionCookieNames(cookies, "sb-example-auth-token")).toEqual([
      "sb-example-auth-token",
      "sb-example-auth-token.0",
    ]);
    expect(getSupabaseAuthFlowCookieNames(cookies, "sb-example-auth-token")).toEqual([
      "sb-example-auth-token",
      "sb-example-auth-token.0",
      "sb-example-auth-token-code-verifier",
    ]);
  });

  it("recognizes invalid session errors by code or message", () => {
    expect(
      isSupabaseInvalidSessionError({
        code: "refresh_token_not_found",
        message: "Invalid Refresh Token: Refresh Token Not Found",
      }),
    ).toBe(true);
    expect(
      isSupabaseInvalidSessionError({
        message: "Auth session missing!",
      }),
    ).toBe(true);
    expect(
      isSupabaseInvalidSessionError({
        code: "unexpected_error",
        message: "Something else broke",
      }),
    ).toBe(false);
  });

  it("returns the user when Supabase auth succeeds", async () => {
    const user = { id: "user-123" };

    await expect(
      getSupabaseUserOrNull({
        auth: {
          getUser: async () => ({
            data: {
              user: user as never,
            },
            error: null,
          }),
        },
      }),
    ).resolves.toEqual(user);
  });

  it("returns null when Supabase reports an invalid session", async () => {
    await expect(
      getSupabaseUserOrNull({
        auth: {
          getUser: async () => ({
            data: {
              user: null,
            },
            error: {
              code: "refresh_token_not_found",
              message: "Invalid Refresh Token: Refresh Token Not Found",
            },
          }),
        },
      }),
    ).resolves.toBeNull();
  });

  it("rethrows unexpected auth errors", async () => {
    await expect(
      getSupabaseUserOrNull({
        auth: {
          getUser: async () => ({
            data: {
              user: null,
            },
            error: new Error("database offline"),
          }),
        },
      }),
    ).rejects.toThrow("database offline");
  });
});
