import type { User } from "@supabase/supabase-js";

import { resolveSupabasePublicConfig } from "@/lib/supabase/config";

const INVALID_SESSION_ERROR_CODES = new Set([
  "bad_jwt",
  "invalid_grant",
  "invalid_jwt",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_expired",
  "session_not_found",
]);

const INVALID_SESSION_ERROR_MESSAGES = [
  "Auth session missing",
  "Invalid JWT",
  "Invalid Refresh Token",
  "JWT has expired",
  "Refresh Token Not Found",
];

const INVALID_SESSION_ERROR_NAMES = new Set(["AuthInvalidJwtError", "AuthSessionMissingError"]);

type AuthCookie = {
  name: string;
};

type SupabaseAuthClientLike = {
  auth: {
    getUser: () => Promise<{
      data: {
        user: User | null;
      };
      error: unknown | null;
    }>;
  };
};

type SupabaseClaimsClientLike = {
  auth: {
    getClaims: () => Promise<{
      data: {
        claims: Record<string, unknown>;
        header: Record<string, unknown>;
      } | null;
      error: unknown | null;
    }>;
  };
};

export type SupabaseAuthIdentity = {
  email?: string | null;
  id: string;
};

export type SupabaseAuthVerification = {
  authUserRequests: 0 | 1;
  claimsVerifications: 0 | 1;
  durationMs: number;
  identity: SupabaseAuthIdentity | null;
  method: "auth-user" | "claims-jwks" | "unknown";
};

export function getSupabaseAuthCookieBaseName(
  input: Record<string, string | undefined> = process.env,
) {
  const { url } = resolveSupabasePublicConfig(input);
  const hostnamePrefix = new URL(url).hostname.split(".")[0];

  return `sb-${hostnamePrefix}-auth-token`;
}

export function isSupabaseSessionCookieName(
  name: string,
  baseName = getSupabaseAuthCookieBaseName(),
) {
  return name === baseName || name.startsWith(`${baseName}.`);
}

export function isSupabaseAuthFlowCookieName(
  name: string,
  baseName = getSupabaseAuthCookieBaseName(),
) {
  return (
    isSupabaseSessionCookieName(name, baseName) ||
    name === `${baseName}-code-verifier` ||
    name.startsWith(`${baseName}-code-verifier.`)
  );
}

export function getSupabaseSessionCookieNames(
  cookies: AuthCookie[],
  baseName = getSupabaseAuthCookieBaseName(),
) {
  return cookies
    .filter(({ name }) => isSupabaseSessionCookieName(name, baseName))
    .map(({ name }) => name);
}

export function getSupabaseAuthFlowCookieNames(
  cookies: AuthCookie[],
  baseName = getSupabaseAuthCookieBaseName(),
) {
  return cookies
    .filter(({ name }) => isSupabaseAuthFlowCookieName(name, baseName))
    .map(({ name }) => name);
}

export function isSupabaseInvalidSessionError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  const name = "name" in error && typeof error.name === "string" ? error.name : null;

  return (
    (name !== null && INVALID_SESSION_ERROR_NAMES.has(name)) ||
    (code !== null && INVALID_SESSION_ERROR_CODES.has(code)) ||
    INVALID_SESSION_ERROR_MESSAGES.some((fragment) => message.includes(fragment))
  );
}

function roundDuration(durationMs: number) {
  return Math.round(durationMs * 10) / 10;
}

function claimsVerificationMethod(header: Record<string, unknown>) {
  const algorithm = typeof header.alg === "string" ? header.alg : null;
  const hasKeyId = typeof header.kid === "string" && header.kid.length > 0;
  const hasWebCrypto = "crypto" in globalThis && Boolean(globalThis.crypto?.subtle);

  return algorithm && !algorithm.startsWith("HS") && hasKeyId && hasWebCrypto
    ? ("claims-jwks" as const)
    : ("auth-user" as const);
}

export async function verifySupabaseAuthIdentity(
  supabase: SupabaseClaimsClientLike,
  options: { includeEmail?: boolean } = {},
): Promise<SupabaseAuthVerification> {
  const startedAt = performance.now();

  try {
    const { data, error } = await supabase.auth.getClaims();

    if (error) {
      if (isSupabaseInvalidSessionError(error)) {
        return {
          authUserRequests: 0,
          claimsVerifications: 0,
          durationMs: roundDuration(performance.now() - startedAt),
          identity: null,
          method: "unknown",
        };
      }

      throw error;
    }

    if (!data || typeof data.claims.sub !== "string" || data.claims.sub.length === 0) {
      return {
        authUserRequests: 0,
        claimsVerifications: 0,
        durationMs: roundDuration(performance.now() - startedAt),
        identity: null,
        method: "unknown",
      };
    }

    const method = claimsVerificationMethod(data.header);
    const identity: SupabaseAuthIdentity = { id: data.claims.sub };

    if (options.includeEmail) {
      identity.email = typeof data.claims.email === "string" ? data.claims.email : null;
    }

    return {
      authUserRequests: method === "auth-user" ? 1 : 0,
      claimsVerifications: method === "claims-jwks" ? 1 : 0,
      durationMs: roundDuration(performance.now() - startedAt),
      identity,
      method,
    };
  } catch (error) {
    if (isSupabaseInvalidSessionError(error)) {
      return {
        authUserRequests: 0,
        claimsVerifications: 0,
        durationMs: roundDuration(performance.now() - startedAt),
        identity: null,
        method: "unknown",
      };
    }

    throw error;
  }
}

export async function getSupabaseAuthIdentityOrNull(
  supabase: SupabaseClaimsClientLike,
  options?: { includeEmail?: boolean },
) {
  const { identity } = await verifySupabaseAuthIdentity(supabase, options);
  return identity;
}

export async function getSupabaseUserOrNull(supabase: SupabaseAuthClientLike) {
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error) {
      if (isSupabaseInvalidSessionError(error)) {
        return null;
      }

      throw error;
    }

    return user;
  } catch (error) {
    if (isSupabaseInvalidSessionError(error)) {
      return null;
    }

    throw error;
  }
}
