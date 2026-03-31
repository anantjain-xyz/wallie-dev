import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import {
  getSupabaseAuthFlowCookieNames,
  getSupabaseSessionCookieNames,
  getSupabaseUserOrNull,
} from "@/lib/supabase/auth";
import type { Database } from "@/lib/supabase/database.types";
import { resolveSupabasePublicConfig } from "@/lib/supabase/config";

function clearSupabaseAuthCookies(
  request: NextRequest,
  response: NextResponse,
) {
  const cookieNames = getSupabaseAuthFlowCookieNames(request.cookies.getAll());

  cookieNames.forEach((name) => {
    request.cookies.delete(name);
    response.cookies.set(name, "", {
      maxAge: 0,
      path: "/",
    });
  });
}

export async function updateSupabaseSession(request: NextRequest) {
  let response = NextResponse.next({
    request,
  });
  const { publishableKey, url } = resolveSupabasePublicConfig();
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
        response = NextResponse.next({
          request,
        });

        cookiesToSet.forEach(({ name, options, value }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    clearSupabaseAuthCookies(request, response);
  }

  return response;
}
