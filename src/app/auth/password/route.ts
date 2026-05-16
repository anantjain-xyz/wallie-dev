import { NextRequest, NextResponse } from "next/server";

import { isLocalDev } from "@/env/deploy";
import { ensureProfileForUser, normalizeNextPath, resolveAuthenticatedHomePath } from "@/lib/auth";
import { loginPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type AuthFailure = {
  code?: string;
  message?: string;
};

function getEntryPath(next: string, params: Record<string, string>) {
  const basePath = loginPath(next);
  const searchParams = new URLSearchParams(params);
  const separator = basePath.includes("?") ? "&" : "?";

  return `${basePath}${separator}${searchParams.toString()}`;
}

function isInvalidCredentialsError(error: AuthFailure | null) {
  if (!error) {
    return false;
  }

  return (
    error.code === "invalid_credentials" ||
    error.message?.toLowerCase().includes("invalid login credentials") === true
  );
}

export async function POST(request: NextRequest) {
  if (!isLocalDev()) {
    return NextResponse.json(null, { status: 404 });
  }

  const formData = await request.formData();
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = normalizeNextPath(String(formData.get("next") ?? ""));

  if (!email || password.length < 6) {
    return NextResponse.redirect(
      new URL(getEntryPath(next, { error: "password_auth_failed" }), request.url),
      { status: 303 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const signInResult = await supabase.auth.signInWithPassword({ email, password });

  if (signInResult.error && isInvalidCredentialsError(signInResult.error)) {
    const signUpResult = await supabase.auth.signUp({ email, password });

    if (signUpResult.error) {
      return NextResponse.redirect(
        new URL(getEntryPath(next, { error: "password_auth_failed" }), request.url),
        { status: 303 },
      );
    }
  } else if (signInResult.error) {
    return NextResponse.redirect(
      new URL(getEntryPath(next, { error: "password_auth_failed" }), request.url),
      { status: 303 },
    );
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
