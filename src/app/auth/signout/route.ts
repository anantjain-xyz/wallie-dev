import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const formData = await request.formData().catch(() => null);
  const next = normalizeNextPath(String(formData?.get("next") ?? ""));
  const supabase = await createSupabaseServerClient();

  await supabase.auth.signOut();

  return NextResponse.redirect(new URL(loginPath(next), request.url), {
    status: 303,
  });
}
