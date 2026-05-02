import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";

import { ensureProfileForUser, normalizeNextPath, resolveAuthenticatedHomePath } from "@/lib/auth";
import { isLocalDev } from "@/env/deploy";
import { loginPath, signupPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const authModeSchema = z.enum(["login", "signup"]);

function getEntryPath(mode: "login" | "signup", next: string, params: Record<string, string>) {
  const basePath = mode === "signup" ? signupPath(next) : loginPath(next);
  const searchParams = new URLSearchParams(params);
  const separator = basePath.includes("?") ? "&" : "?";

  return `${basePath}${separator}${searchParams.toString()}`;
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
  const mode = authModeSchema.catch("login").parse(formData.get("mode"));
  const next = normalizeNextPath(String(formData.get("next") ?? ""));

  if (!email || password.length < 6) {
    return NextResponse.redirect(
      new URL(getEntryPath(mode, next, { error: "password_auth_failed" }), request.url),
      { status: 303 },
    );
  }

  const supabase = await createSupabaseServerClient();

  const { error } =
    mode === "signup"
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return NextResponse.redirect(
      new URL(getEntryPath(mode, next, { error: "password_auth_failed" }), request.url),
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
