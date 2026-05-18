import { NextRequest, NextResponse } from "next/server";

import { resolveAuthenticatedSettingsPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.redirect(
      new URL(loginPath("/?codex_connect=oauth_unsupported"), request.url),
      { status: 303 },
    );
  }

  const url = new URL(await resolveAuthenticatedSettingsPath(supabase), request.url);
  url.searchParams.set("codex_connect", "oauth_unsupported");
  return NextResponse.redirect(url, { status: 303 });
}
