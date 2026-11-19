import type { NextRequest } from "next/server";

import { sessionReviewReturnPath } from "@/lib/sessions/review-link";
import { updateSupabaseSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSupabaseSession(request, sessionReviewReturnPath(request.nextUrl));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
