import { NextResponse } from "next/server";
import { z } from "zod";

import { listOpenCodeProviderCredentialMeta } from "@/lib/opencode/tokens";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

const requestSchema = z.object({
  credential: z
    .string({ invalid_type_error: "Credential must be a string." })
    .trim()
    .min(20, "Credential is too short.")
    .max(4096, "Credential is too long."),
});

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await loadOpenCodeConnectionStatus(user.id));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load OpenCode connection.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
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
      { error: parsed.error.issues[0]?.message ?? "Invalid OpenCode Zen API key." },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("user_opencode_credentials").upsert(
    {
      encrypted_api_key: encryptSecretValue(parsed.data.credential),
      updated_at: now,
      user_id: user.id,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  try {
    return NextResponse.json(await loadOpenCodeConnectionStatus(user.id, admin));
  } catch (loadError) {
    const message =
      loadError instanceof Error ? loadError.message : "Failed to load OpenCode connection.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("user_opencode_credentials").delete().eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}

async function loadOpenCodeConnectionStatus(
  userId: string,
  admin: SupabaseClient<Database> = createSupabaseAdminClient(),
) {
  const [{ data, error }, providers] = await Promise.all([
    admin
      .from("user_opencode_credentials")
      .select("updated_at")
      .eq("user_id", userId)
      .maybeSingle(),
    listOpenCodeProviderCredentialMeta(admin, userId),
  ]);

  if (error) throw error;

  const checkedAt = new Date().toISOString();
  if (!data) {
    return { checkedAt, connected: false, providers };
  }

  return {
    checkedAt,
    connected: true,
    providers,
    updatedAt: data.updated_at,
  };
}
