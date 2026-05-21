import { NextRequest, NextResponse } from "next/server";

import { ensureProfileForUser, normalizeNextPath, resolveAuthenticatedHomePath } from "@/lib/auth";
import {
  emailCodeAuthCookieName,
  emailCodeAuthCookieOptions,
  normalizeEmailCodeAddress,
} from "@/lib/auth-email-code-cookie";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const EMAIL_CODE_PATTERN = /^\d{6}$/;

function getEntryPath(next: string, params: Record<string, string | undefined>) {
  const basePath = loginPath(next);
  const searchParams = new URLSearchParams();
  const separator = basePath.includes("?") ? "&" : "?";

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      searchParams.set(key, value);
    }
  }

  return `${basePath}${separator}${searchParams.toString()}`;
}

function redirectToEntry(
  request: NextRequest,
  next: string,
  params: Record<string, string | undefined>,
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

function getEmailCodeToken(formData: FormData) {
  const token = String(formData.get("token") ?? "").replace(/\s+/g, "");

  if (token) {
    return token;
  }

  return formData
    .getAll("tokenDigit")
    .map((value) => String(value))
    .join("")
    .replace(/\s+/g, "");
}

function getEmailCodeAddress(request: NextRequest, formData: FormData) {
  const cookieEmail = normalizeEmailCodeAddress(
    request.cookies.get(emailCodeAuthCookieName)?.value,
  );

  if (cookieEmail) {
    return cookieEmail;
  }

  return normalizeEmailCodeAddress(String(formData.get("email") ?? ""));
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = getEmailCodeAddress(request, formData);
  const next = normalizeNextPath(String(formData.get("next") ?? ""));
  const token = getEmailCodeToken(formData);

  if (!email || !EMAIL_CODE_PATTERN.test(token)) {
    return redirectToEntry(request, next, { error: "email_code_failed" }, email);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });

  if (error) {
    return redirectToEntry(request, next, { error: "email_code_failed" }, email);
  }

  const user = await getSupabaseUserOrNull(supabase);

  if (user) {
    await ensureProfileForUser(supabase, user);
  }

  const redirectTarget = next === "/" ? await resolveAuthenticatedHomePath(supabase) : next;

  return redirectToAuthenticatedPath(request, redirectTarget);
}
