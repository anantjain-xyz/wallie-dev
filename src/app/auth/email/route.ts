import { NextRequest, NextResponse } from "next/server";

import { normalizeNextPath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function getEntryPath(next: string, params: Record<string, string>) {
  const basePath = loginPath(next);
  const searchParams = new URLSearchParams(params);
  const separator = basePath.includes("?") ? "&" : "?";

  return `${basePath}${separator}${searchParams.toString()}`;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const next = normalizeNextPath(String(formData.get("next") ?? ""));

  if (!email) {
    return NextResponse.redirect(
      new URL(getEntryPath(next, { error: "email_sign_in_failed" }), request.url),
      { status: 303 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const confirmUrl = new URL("/auth/confirm", request.url);

  confirmUrl.searchParams.set("next", next);

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: confirmUrl.toString(),
    },
  });

  if (error) {
    return NextResponse.redirect(
      new URL(getEntryPath(next, { error: "email_sign_in_failed" }), request.url),
      { status: 303 },
    );
  }

  return NextResponse.redirect(
    new URL(getEntryPath(next, { status: "check_email", email }), request.url),
    { status: 303 },
  );
}
