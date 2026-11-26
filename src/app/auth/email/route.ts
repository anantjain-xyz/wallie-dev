import { NextRequest, NextResponse } from "next/server";

import { buildAppUrl } from "@/lib/app-url";
import { normalizeNextPath } from "@/lib/auth";
import {
  emailCodeAuthCookieName,
  emailCodeAuthCookieOptions,
  emailSignInRetryCookieName,
  normalizeEmailCodeAddress,
} from "@/lib/auth-email-code-cookie";
import { loginPath } from "@/lib/routes";
import {
  createSessionSearchContinuation,
  readSessionSearchContinuation,
  sessionSearchCookieName,
  sessionSearchCookieOptions,
} from "@/lib/session-search-continuation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { sanitizeAuthSessionNext } from "@/lib/workspace-return-path";

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
  email?: { kind: "sent" | "retry"; address: string },
) {
  const retryId = email?.kind === "retry" ? crypto.randomUUID() : undefined;
  const location = getEntryPath(next, retryId ? { ...params, retry: retryId } : params);
  const response = NextResponse.redirect(new URL(location, request.url), {
    status: 303,
  });

  if (email?.kind === "sent") {
    response.cookies.set(emailCodeAuthCookieName, email.address, emailCodeAuthCookieOptions);
  }
  response.cookies.set(emailSignInRetryCookieName, retryId ? `${retryId}:${email?.address}` : "", {
    ...emailCodeAuthCookieOptions,
    maxAge: retryId ? emailCodeAuthCookieOptions.maxAge : 0,
  });

  return response;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = normalizeEmailCodeAddress(String(formData.get("email") ?? ""));
  const next = sanitizeAuthSessionNext(normalizeNextPath(String(formData.get("next") ?? "")));

  if (!email) {
    return redirectToEntry(request, next, { error: "email_sign_in_failed" });
  }

  const supabase = await createSupabaseServerClient();
  const confirmUrl = buildAppUrl("/auth/confirm");
  const continuation = createSessionSearchContinuation(
    next,
    readSessionSearchContinuation(next, request.cookies.get(sessionSearchCookieName)?.value),
  );
  const returnPath = continuation?.next ?? next;

  confirmUrl.searchParams.set("next", returnPath);

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: confirmUrl.toString(),
    },
  });

  if (error) {
    return redirectToEntry(
      request,
      next,
      { error: "email_sign_in_failed" },
      {
        kind: "retry",
        address: email,
      },
    );
  }

  const response = redirectToEntry(
    request,
    returnPath,
    { status: "check_email" },
    {
      kind: "sent",
      address: email,
    },
  );
  if (continuation) {
    response.cookies.set(sessionSearchCookieName, continuation.cookie, sessionSearchCookieOptions);
  }
  return response;
}
