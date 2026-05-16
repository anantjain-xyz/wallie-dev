import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath } from "@/lib/auth";
import { OAUTH_PROVIDERS } from "@/lib/auth-providers";
import { loginPath } from "@/lib/routes";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const oauthProviderSchema = z.enum(OAUTH_PROVIDERS);

function getEntryPath(next: string, error: string) {
  const basePath = loginPath(next);
  const separator = basePath.includes("?") ? "&" : "?";

  return `${basePath}${separator}error=${error}`;
}

export async function GET(request: NextRequest) {
  const next = normalizeNextPath(request.nextUrl.searchParams.get("next"));
  const providerResult = oauthProviderSchema.safeParse(
    request.nextUrl.searchParams.get("provider"),
  );

  if (!providerResult.success) {
    return NextResponse.redirect(new URL(getEntryPath(next, "invalid_provider"), request.url), {
      status: 303,
    });
  }

  const supabase = await createSupabaseServerClient();
  const callbackUrl = new URL("/auth/callback", request.url);

  callbackUrl.searchParams.set("next", next);

  const { data, error } = await supabase.auth.signInWithOAuth({
    options: {
      redirectTo: callbackUrl.toString(),
    },
    provider: providerResult.data,
  });

  if (error || !data.url) {
    return NextResponse.redirect(new URL(getEntryPath(next, "oauth_sign_in_failed"), request.url), {
      status: 303,
    });
  }

  return NextResponse.redirect(data.url, { status: 303 });
}
