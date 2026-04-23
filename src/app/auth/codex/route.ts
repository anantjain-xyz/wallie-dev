import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath, resolveAuthenticatedSettingsPath } from "@/lib/auth";
import {
  CODEX_OAUTH_COOKIE,
  CODEX_OAUTH_COOKIE_MAX_AGE,
  buildCodexAuthorizeUrl,
  generatePkcePair,
  generateState,
} from "@/lib/codex/oauth";
import { loginPath } from "@/lib/routes";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  const fallbackSettingsPath = user ? await resolveAuthenticatedSettingsPath(supabase) : "/";
  const next = normalizeNextPath(request.nextUrl.searchParams.get("next"), fallbackSettingsPath);

  if (!user) {
    return NextResponse.redirect(
      new URL(loginPath(`/auth/codex?next=${encodeURIComponent(next)}`), request.url),
      {
        status: 303,
      },
    );
  }

  const { verifier, challenge } = generatePkcePair();
  const state = generateState();
  const redirectUri = new URL("/auth/callback/codex", request.url).toString();

  const cookieValue = encryptSecretValue(JSON.stringify({ verifier, state, next, redirectUri }));

  const authorizeUrl = buildCodexAuthorizeUrl({
    redirectUri,
    state,
    codeChallenge: challenge,
  });

  const response = NextResponse.redirect(authorizeUrl, { status: 303 });
  response.cookies.set(CODEX_OAUTH_COOKIE, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: CODEX_OAUTH_COOKIE_MAX_AGE,
  });
  return response;
}
