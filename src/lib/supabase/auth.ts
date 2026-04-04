import type { User } from "@supabase/supabase-js";

import { resolveSupabasePublicConfig } from "@/lib/supabase/config";

const INVALID_SESSION_ERROR_CODES = new Set([
  "invalid_grant",
  "refresh_token_not_found",
  "session_not_found",
]);

const INVALID_SESSION_ERROR_MESSAGES = [
  "Auth session missing",
  "Invalid Refresh Token",
  "Refresh Token Not Found",
];

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

  return (
    (code !== null && INVALID_SESSION_ERROR_CODES.has(code)) ||
    INVALID_SESSION_ERROR_MESSAGES.some((fragment) => message.includes(fragment))
  );
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
