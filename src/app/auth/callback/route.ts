import { NextRequest, NextResponse } from "next/server";

import {
  ensureProfileForUser,
  normalizeNextPath,
  resolveAuthenticatedHomePath,
} from "@/lib/auth";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function loginErrorPath(next: string, error: string) {
  return `/login?error=${error}&next=${encodeURIComponent(next)}`;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const next = normalizeNextPath(request.nextUrl.searchParams.get("next"));

  if (!code) {
    return NextResponse.redirect(
      new URL(loginErrorPath(next, "auth_callback_failed"), request.url),
      { status: 303 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(loginErrorPath(next, "auth_callback_failed"), request.url),
      { status: 303 },
    );
  }

  const user = await getSupabaseUserOrNull(supabase);

  if (user) {
    await ensureProfileForUser(supabase, user);
  }

  const redirectTarget =
    next === "/" ? await resolveAuthenticatedHomePath(supabase) : next;

  return NextResponse.redirect(new URL(redirectTarget, request.url), {
    status: 303,
  });
}
