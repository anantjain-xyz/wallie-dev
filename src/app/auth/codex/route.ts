import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath, resolveAuthenticatedSettingsPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
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
      { status: 303 },
    );
  }

  const url = new URL(next, request.url);
  url.searchParams.set("codex_connect", "oauth_unsupported");
  return NextResponse.redirect(url, { status: 303 });
}
