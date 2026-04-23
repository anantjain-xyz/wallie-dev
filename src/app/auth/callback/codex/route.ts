import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath, resolveAuthenticatedSettingsPath } from "@/lib/auth";
import {
  CODEX_OAUTH_COOKIE,
  exchangeAuthorizationCode,
  readIdentityFromIdToken,
} from "@/lib/codex/oauth";
import { loginPath } from "@/lib/routes";
import { decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function redirectToNext(request: NextRequest, next: string, query: Record<string, string>) {
  const url = new URL(next.startsWith("/") ? next : "/", request.url);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, { status: 303 });
}

function clearCookie(response: NextResponse) {
  response.cookies.set(CODEX_OAUTH_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}

interface StashedState {
  verifier: string;
  state: string;
  next: string;
  redirectUri: string;
}

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.redirect(
      new URL(loginPath("/?codex_connect=unauthenticated"), request.url),
      { status: 303 },
    );
  }

  const fallbackSettingsPath = await resolveAuthenticatedSettingsPath(supabase);

  const cookieValue = request.cookies.get(CODEX_OAUTH_COOKIE)?.value;
  const returnedState = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const providerError = request.nextUrl.searchParams.get("error");

  if (!cookieValue) {
    return clearCookie(
      redirectToNext(request, fallbackSettingsPath, { codex_connect: "state_missing" }),
    );
  }

  let stash: StashedState;
  try {
    stash = JSON.parse(decryptSecretValue(cookieValue)) as StashedState;
  } catch {
    return clearCookie(
      redirectToNext(request, fallbackSettingsPath, { codex_connect: "state_invalid" }),
    );
  }

  const next = normalizeNextPath(stash.next, fallbackSettingsPath);

  if (providerError) {
    return clearCookie(redirectToNext(request, next, { codex_connect: providerError }));
  }

  if (!code || !returnedState || returnedState !== stash.state) {
    return clearCookie(redirectToNext(request, next, { codex_connect: "state_mismatch" }));
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      code,
      redirectUri: stash.redirectUri,
      codeVerifier: stash.verifier,
    });
  } catch (err) {
    console.error("[auth/callback/codex] token exchange failed", {
      error: err instanceof Error ? err.message : String(err),
      userId: user.id,
    });
    return clearCookie(redirectToNext(request, next, { codex_connect: "token_exchange_failed" }));
  }

  const identity = readIdentityFromIdToken(tokens.id_token);
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("user_codex_credentials").upsert(
    {
      user_id: user.id,
      encrypted_access_token: encryptSecretValue(tokens.access_token),
      encrypted_refresh_token: encryptSecretValue(tokens.refresh_token),
      access_token_expires_at: expiresAt,
      scope: tokens.scope ?? null,
      account_id: identity.accountId,
      account_email: identity.email,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) {
    console.error("[auth/callback/codex] credential persistence failed", {
      error: error.message,
      userId: user.id,
    });
    return clearCookie(redirectToNext(request, next, { codex_connect: "persist_failed" }));
  }

  return clearCookie(redirectToNext(request, next, { codex_connect: "success" }));
}
