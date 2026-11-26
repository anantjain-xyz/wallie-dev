import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import {
  sessionSearchCookieName,
  sessionSearchCookieOptions,
} from "@/lib/session-search-continuation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sanitizeAuthSessionNext } from "@/lib/workspace-return-path";

export async function POST(request: NextRequest) {
  const formData = await request.formData().catch(() => null);
  const next = sanitizeAuthSessionNext(normalizeNextPath(String(formData?.get("next") ?? "")));
  const switchAccount = formData?.get("switchAccount") === "1";
  const result = await createSupabaseServerClient()
    .then((supabase) =>
      switchAccount ? supabase.auth.signOut({ scope: "local" }) : supabase.auth.signOut(),
    )
    .catch(() => null);
  if (!result || result.error) {
    return NextResponse.redirect(new URL("/recovery?signOut=failed", request.url), {
      status: 303,
    });
  }

  const response = NextResponse.redirect(new URL(loginPath(next), request.url), { status: 303 });
  response.cookies.set(sessionSearchCookieName, "", { ...sessionSearchCookieOptions, maxAge: 0 });
  return response;
}
