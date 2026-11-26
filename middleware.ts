import type { NextRequest } from "next/server";

import { updateSupabaseSession } from "@/lib/supabase/middleware";
import { createSessionSearchContinuation } from "@/lib/session-search-continuation";
import { workspaceReturnPath } from "@/lib/workspace-return-path";

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const next = workspaceReturnPath(`${pathname}${search}`);
  const continuation =
    next &&
    request.method === "GET" &&
    !request.headers.has("next-router-prefetch") &&
    !request.headers.has("next-router-segment-prefetch") &&
    request.headers.get("purpose") !== "prefetch"
      ? createSessionSearchContinuation(next, request.nextUrl.searchParams.get("q"))
      : null;
  return updateSupabaseSession(request, continuation?.next ?? next, continuation?.cookie);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
