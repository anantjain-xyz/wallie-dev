import { describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";

import {
  getSupabaseAuthCookieBaseName,
  getSupabaseAuthIdentityOrNull,
  getSupabaseAuthFlowCookieNames,
  getSupabaseSessionCookieNames,
  getSupabaseUserOrNull,
  isSupabaseInvalidSessionError,
  verifySupabaseAuthIdentity,
} from "@/lib/supabase/auth";

const publicEnv = {
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
};

function encodeJwtPart(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function createAsymmetricJwt() {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const header = encodeJwtPart({ alg: "ES256", kid: "test-key", typ: "JWT" });
  const payload = encodeJwtPart({
    email: "person@example.com",
    exp: Math.floor(Date.now() / 1_000) + 3_600,
    sub: "user-123",
  });
  const signature = await crypto.subtle.sign(
    { hash: "SHA-256", name: "ECDSA" },
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);

  return {
    jwk: { ...jwk, alg: "ES256", kid: "test-key", use: "sig" },
    token: `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`,
  };
}

describe("supabase auth helpers", () => {
  it("derives the auth cookie base name from the Supabase host", () => {
    expect(getSupabaseAuthCookieBaseName(publicEnv)).toBe("sb-example-auth-token");
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
        message: "Invalid JWT signature",
        name: "AuthInvalidJwtError",
      }),
    ).toBe(true);
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

  it("derives a minimal identity from asymmetric verified claims without a user request", async () => {
    const getClaims = vi.fn().mockResolvedValue({
      data: {
        claims: { email: "person@example.com", sub: "user-123" },
        header: { alg: "ES256", kid: "signing-key" },
      },
      error: null,
    });

    await expect(verifySupabaseAuthIdentity({ auth: { getClaims } })).resolves.toMatchObject({
      authUserRequests: 0,
      claimsVerifications: 1,
      identity: { id: "user-123" },
      method: "claims-jwks",
    });
    await expect(getSupabaseAuthIdentityOrNull({ auth: { getClaims } })).resolves.toEqual({
      id: "user-123",
    });
    expect(getClaims).toHaveBeenCalledTimes(2);
  });

  it("includes verified email only when the caller requires it", async () => {
    const client = {
      auth: {
        getClaims: async () => ({
          data: {
            claims: { email: "person@example.com", sub: "user-123" },
            header: { alg: "ES256", kid: "signing-key" },
          },
          error: null,
        }),
      },
    };

    await expect(getSupabaseAuthIdentityOrNull(client, { includeEmail: true })).resolves.toEqual({
      email: "person@example.com",
      id: "user-123",
    });
  });

  it("reports the verified auth-user fallback for symmetric signing", async () => {
    await expect(
      verifySupabaseAuthIdentity({
        auth: {
          getClaims: async () => ({
            data: {
              claims: { sub: "user-123" },
              header: { alg: "HS256" },
            },
            error: null,
          }),
        },
      }),
    ).resolves.toMatchObject({
      authUserRequests: 1,
      claimsVerifications: 0,
      identity: { id: "user-123" },
      method: "auth-user",
    });
  });

  it("performs zero auth user requests when Supabase verifies an asymmetric token", async () => {
    const { jwk, token } = await createAsymmetricJwt();
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);

      if (url.endsWith("/.well-known/jwks.json")) {
        return Response.json({ keys: [jwk] });
      }

      throw new Error(`Unexpected Auth request: ${url}`);
    });
    const client = createClient("https://example.supabase.co", "publishable-key", {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { fetch },
    });

    const result = await verifySupabaseAuthIdentity({
      auth: { getClaims: () => client.auth.getClaims(token) },
    });

    expect(result).toMatchObject({
      authUserRequests: 0,
      claimsVerifications: 1,
      identity: { id: "user-123" },
      method: "claims-jwks",
    });
    expect(requests.filter((url) => url.endsWith("/auth/v1/user"))).toHaveLength(0);
    expect(requests.filter((url) => url.endsWith("/.well-known/jwks.json"))).toHaveLength(1);
  });

  it("uses exactly one auth user request to verify a symmetric token", async () => {
    const token = `${encodeJwtPart({ alg: "HS256", typ: "JWT" })}.${encodeJwtPart({
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      sub: "user-123",
    })}.c2lnbmF0dXJl`;
    const requests: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);

      if (url.endsWith("/auth/v1/user")) {
        return Response.json({ id: "user-123" });
      }

      throw new Error(`Unexpected Auth request: ${url}`);
    });
    const client = createClient("https://example.supabase.co", "publishable-key", {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
      global: { fetch },
    });

    const result = await verifySupabaseAuthIdentity({
      auth: { getClaims: () => client.auth.getClaims(token) },
    });

    expect(result).toMatchObject({
      authUserRequests: 1,
      claimsVerifications: 0,
      identity: { id: "user-123" },
      method: "auth-user",
    });
    expect(requests.filter((url) => url.endsWith("/auth/v1/user"))).toHaveLength(1);
  });

  it.each([
    ["expired", { message: "JWT has expired", name: "AuthInvalidJwtError" }],
    ["malformed", { message: "Invalid JWT structure", name: "AuthInvalidJwtError" }],
    ["invalid signature", { message: "Invalid JWT signature", name: "AuthInvalidJwtError" }],
  ])("fails closed for %s claims", async (_variant, error) => {
    await expect(
      getSupabaseAuthIdentityOrNull({
        auth: {
          getClaims: async () => ({ data: null, error }),
        },
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when verified claims do not contain a subject", async () => {
    await expect(
      getSupabaseAuthIdentityOrNull({
        auth: {
          getClaims: async () => ({
            data: { claims: { email: "person@example.com" }, header: { alg: "ES256" } },
            error: null,
          }),
        },
      }),
    ).resolves.toBeNull();
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
