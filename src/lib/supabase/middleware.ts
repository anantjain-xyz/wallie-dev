import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { SESSION_REVIEW_RETURN_HEADER } from "@/lib/sessions/review-link";
import {
  getSupabaseAuthFlowCookieNames,
  getSupabaseSessionCookieNames,
  verifySupabaseAuthIdentity,
} from "@/lib/supabase/auth";
import type { Database } from "@/lib/supabase/database.types";
import { resolveSupabasePublicConfig } from "@/lib/supabase/config";

function clearSupabaseAuthCookies(request: NextRequest, response: NextResponse) {
  const cookieNames = getSupabaseAuthFlowCookieNames(request.cookies.getAll());

  cookieNames.forEach((name) => {
    request.cookies.delete(name);
    response.cookies.set(name, "", {
      maxAge: 0,
      path: "/",
    });
  });
}

export async function updateSupabaseSession(request: NextRequest, reviewReturnPath?: string) {
  function continueWithRequest() {
    if (!reviewReturnPath && !request.headers.has(SESSION_REVIEW_RETURN_HEADER)) {
      return NextResponse.next({ request });
    }
    const forwarded = new Headers(request.headers);
    forwarded.delete(SESSION_REVIEW_RETURN_HEADER);
    if (reviewReturnPath) forwarded.set(SESSION_REVIEW_RETURN_HEADER, reviewReturnPath);
    return NextResponse.next({ request: { headers: forwarded } });
  }
  let response = continueWithRequest();
  const { publishableKey, url } = resolveSupabasePublicConfig(process.env);
  const sessionCookieNames = getSupabaseSessionCookieNames(request.cookies.getAll());

  if (sessionCookieNames.length === 0) {
    return response;
  }

  const supabase = createServerClient<Database>(url, publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        response = continueWithRequest();

        cookiesToSet.forEach(({ name, options, value }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const verification = await verifySupabaseAuthIdentity(supabase);

  if (process.env.WALLIE_TIMING_LOGS === "1") {
    console.info("[auth-verification]", {
      authUserRequests: verification.authUserRequests,
      claimsVerifications: verification.claimsVerifications,
      durationMs: verification.durationMs,
      method: verification.method,
      name: "middleware.auth",
      ok: Boolean(verification.identity),
    });
  }

  if (!verification.identity) {
    clearSupabaseAuthCookies(request, response);
  }

  return response;
}
