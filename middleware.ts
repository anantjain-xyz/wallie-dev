import type { NextRequest } from "next/server";

import { updateSupabaseSession } from "@/lib/supabase/middleware";
import { workspaceReturnPath } from "@/lib/workspace-return-path";

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  return updateSupabaseSession(request, workspaceReturnPath(`${pathname}${search}`));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
