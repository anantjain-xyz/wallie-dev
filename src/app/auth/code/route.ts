import { NextRequest, NextResponse } from "next/server";

import { ensureProfileForUser, normalizeNextPath, resolveAuthenticatedHomePath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const EMAIL_CODE_PATTERN = /^\d{6}$/;

function getEntryPath(next: string, error: string) {
  const basePath = loginPath(next);
  const separator = basePath.includes("?") ? "&" : "?";

  return `${basePath}${separator}error=${error}`;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const next = normalizeNextPath(String(formData.get("next") ?? ""));
  const token = String(formData.get("token") ?? "").replace(/\s+/g, "");

  if (!email || !EMAIL_CODE_PATTERN.test(token)) {
    return NextResponse.redirect(new URL(getEntryPath(next, "email_code_failed"), request.url), {
      status: 303,
    });
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });

  if (error) {
    return NextResponse.redirect(new URL(getEntryPath(next, "email_code_failed"), request.url), {
      status: 303,
    });
  }

  const user = await getSupabaseUserOrNull(supabase);

  if (user) {
    await ensureProfileForUser(supabase, user);
  }

  const redirectTarget = next === "/" ? await resolveAuthenticatedHomePath(supabase) : next;

  return NextResponse.redirect(new URL(redirectTarget, request.url), {
    status: 303,
  });
}
