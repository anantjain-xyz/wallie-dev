import { NextResponse } from "next/server";
import { z } from "zod";

import { CODEX_CREDENTIAL_TYPES, mapCodexCredentialConnectionStatus } from "@/lib/codex/contracts";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const requestSchema = z
  .object({
    credential: z
      .string({ invalid_type_error: "Credential must be a string." })
      .trim()
      .min(20, "Credential is too short.")
      .max(4096, "Credential is too long."),
    credentialType: z.enum(CODEX_CREDENTIAL_TYPES),
    expiresAt: z.string().trim().datetime().nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.credentialType === "chatgpt_auth_json") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use Sign in with ChatGPT to connect a ChatGPT subscription.",
        path: ["credentialType"],
      });
      return;
    }

    if (value.credentialType === "platform_api_key") {
      if (!value.credential.startsWith("sk-")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "OpenAI API keys should start with sk-.",
          path: ["credential"],
        });
      }
      return;
    }

    if (!value.expiresAt) return;
    const expiresAt = new Date(value.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expiration must be in the future.",
        path: ["expiresAt"],
      });
    }
  });

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("user_codex_credentials")
    .select(
      "account_email, access_token_expires_at, auth_cache_last_refresh, auth_reconnect_reason, auth_reconnect_required, credential_type, updated_at",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json(mapCodexCredentialConnectionStatus(data));
}

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid Codex credential." },
      { status: 400 },
    );
  }

  const { credential, credentialType } = parsed.data;
  const expiresAt =
    credentialType === "codex_access_token" ? (parsed.data.expiresAt ?? null) : null;
  const now = new Date().toISOString();
  const admin = createSupabaseAdminClient();

  const { data, error } = await admin
    .from("user_codex_credentials")
    .upsert(
      {
        access_token_expires_at: expiresAt,
        account_email: null,
        account_id: null,
        auth_cache_last_refresh: null,
        auth_lock_expires_at: null,
        auth_lock_run_id: null,
        auth_reconnect_reason: null,
        auth_reconnect_required: false,
        credential_type: credentialType,
        credential_version: 1,
        encrypted_credential: encryptSecretValue(credential),
        scope: null,
        updated_at: now,
        user_id: user.id,
      },
      { onConflict: "user_id" },
    )
    .select(
      "account_email, access_token_expires_at, auth_cache_last_refresh, auth_reconnect_reason, auth_reconnect_required, credential_type, updated_at",
    )
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(mapCodexCredentialConnectionStatus(data));
}

export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("user_codex_credentials").delete().eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
