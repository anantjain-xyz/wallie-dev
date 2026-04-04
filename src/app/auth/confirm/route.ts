import type { EmailOtpType } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

import { ensureProfileForUser, normalizeNextPath, resolveAuthenticatedHomePath } from "@/lib/auth";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function loginErrorPath(next: string, error: string) {
  return `/login?error=${error}&next=${encodeURIComponent(next)}`;
}

function isEmailOtpType(value: string | null): value is EmailOtpType {
  return value === "email" || value === "recovery" || value === "invite";
}

export async function GET(request: NextRequest) {
  const next = normalizeNextPath(request.nextUrl.searchParams.get("next"));
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = request.nextUrl.searchParams.get("type");

  if (!code && (!tokenHash || !isEmailOtpType(type))) {
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
  } else if (tokenHash && isEmailOtpType(type)) {
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

  return NextResponse.redirect(new URL(redirectTarget, request.url), {
    status: 303,
  });
}
