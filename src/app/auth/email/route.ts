import { NextRequest, NextResponse } from "next/server";

import { buildAppUrl } from "@/lib/app-url";
import { normalizeNextPath } from "@/lib/auth";
import {
  emailCodeAuthCookieName,
  emailCodeAuthCookieOptions,
  normalizeEmailCodeAddress,
} from "@/lib/auth-email-code-cookie";
import { loginPath } from "@/lib/routes";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function getEntryPath(next: string, params: Record<string, string>) {
  const basePath = loginPath(next);
  const searchParams = new URLSearchParams(params);
  const separator = basePath.includes("?") ? "&" : "?";

  return `${basePath}${separator}${searchParams.toString()}`;
}

function redirectToEntry(
  request: NextRequest,
  next: string,
  params: Record<string, string>,
  email?: string,
) {
  const response = NextResponse.redirect(new URL(getEntryPath(next, params), request.url), {
    status: 303,
  });

  if (email) {
    response.cookies.set(emailCodeAuthCookieName, email, emailCodeAuthCookieOptions);
  }

  return response;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = normalizeEmailCodeAddress(String(formData.get("email") ?? ""));
  const next = normalizeNextPath(String(formData.get("next") ?? ""));

  if (!email) {
    return redirectToEntry(request, next, { error: "email_sign_in_failed" });
  }

  const supabase = await createSupabaseServerClient();
  const confirmUrl = buildAppUrl("/auth/confirm");

  confirmUrl.searchParams.set("next", next);

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: confirmUrl.toString(),
    },
  });

  if (error) {
    return redirectToEntry(request, next, { error: "email_sign_in_failed" }, email);
  }

  return redirectToEntry(request, next, { status: "check_email" }, email);
}
