import { NextResponse } from "next/server";
import { z } from "zod";

import { CODEX_CREDENTIAL_TYPES } from "@/lib/codex/contracts";
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
    .select("account_email, access_token_expires_at, credential_type, updated_at")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ connected: false });
  }

  const expired = credentialExpired(data.access_token_expires_at);
  return NextResponse.json({
    connected: !expired,
    accountEmail: data.account_email,
    credentialType: data.credential_type,
    expired,
    expiresAt: data.access_token_expires_at,
    updatedAt: data.updated_at,
  });
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
        credential_type: credentialType,
        encrypted_credential: encryptSecretValue(credential),
        scope: null,
        updated_at: now,
        user_id: user.id,
      },
      { onConflict: "user_id" },
    )
    .select("account_email, access_token_expires_at, credential_type, updated_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    connected: true,
    accountEmail: data.account_email,
    credentialType: data.credential_type,
    expired: false,
    expiresAt: data.access_token_expires_at,
    updatedAt: data.updated_at,
  });
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

function credentialExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}
