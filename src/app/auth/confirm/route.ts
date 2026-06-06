import type { EmailOtpType } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { ensureProfileForUser, normalizeNextPath, resolveAuthenticatedHomePath } from "@/lib/auth";
import { emailCodeAuthCookieName, emailCodeAuthCookieOptions } from "@/lib/auth-email-code-cookie";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function loginErrorPath(next: string, error: string) {
  return `/login?error=${error}&next=${encodeURIComponent(next)}`;
}

function normalizeEmailOtpType(value: string | null): EmailOtpType | null {
  if (value === "magiclink") {
    return "email";
  }

  if (value === "email" || value === "recovery" || value === "invite") {
    return value;
  }

  return null;
}

function redirectToAuthenticatedPath(request: NextRequest, redirectTarget: string) {
  const response = NextResponse.redirect(new URL(redirectTarget, request.url), {
    status: 303,
  });

  response.cookies.set(emailCodeAuthCookieName, "", {
    ...emailCodeAuthCookieOptions,
    maxAge: 0,
  });

  return response;
}

export async function GET(request: NextRequest) {
  const next = normalizeNextPath(request.nextUrl.searchParams.get("next"));
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = normalizeEmailOtpType(request.nextUrl.searchParams.get("type"));

  if (!code && (!tokenHash || !type)) {
    return NextResponse.redirect(
      new URL(loginErrorPath(next, "auth_confirmation_failed"), request.url),
      { status: 303 },
    );
  }

  const supabase = await createSupabaseServerClient();
  let error: Error | null = null;

  if (code) {
    const result = await supabase.auth.exchangeCodeForSession(code);

    error = result.error;
  } else if (tokenHash && type) {
    const result = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });

    error = result.error;
  }

  if (error) {
    return NextResponse.redirect(
      new URL(loginErrorPath(next, "auth_confirmation_failed"), request.url),
      { status: 303 },
    );
  }

  const user = await getSupabaseUserOrNull(supabase);

  if (user) {
    await ensureProfileForUser(supabase, user);
  }

  const redirectTarget = next === "/" ? await resolveAuthenticatedHomePath(supabase) : next;

  return redirectToAuthenticatedPath(request, redirectTarget);
}
