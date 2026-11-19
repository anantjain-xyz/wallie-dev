import "server-only";

import { resolveAppOrigin } from "@/lib/app-url";
import { getSupabaseAuthIdentityOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function authenticateFactoryOAuthBrowser() {
  const supabase = await createSupabaseServerClient();
  return getSupabaseAuthIdentityOrNull(supabase, { includeSessionId: true });
}

export function isSameOriginFactoryOAuthPost(request: Request) {
  return request.headers.get("origin") === resolveAppOrigin();
}
