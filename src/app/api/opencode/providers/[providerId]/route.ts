import { NextResponse } from "next/server";
import { z } from "zod";

import { parseOpenCodeProviderId } from "@/lib/agent-config/contracts";
import { listOpenCodeProviderCredentialMeta } from "@/lib/opencode/tokens";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const credentialSchema = z
  .string({ invalid_type_error: "Credential must be a string." })
  .trim()
  .min(20, "Credential is too short.")
  .max(4096, "Credential is too long.");

const putSchema = z.object({ credential: credentialSchema });

type RouteContext = { params: Promise<{ providerId: string }> };

export async function PUT(request: Request, context: RouteContext) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { providerId: rawProviderId } = await context.params;
  const providerId = parseOpenCodeProviderId(decodeURIComponent(rawProviderId));
  if (!providerId.ok) {
    return NextResponse.json({ error: providerId.error }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid OpenCode provider API key." },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("user_opencode_provider_credentials").upsert(
    {
      encrypted_api_key: encryptSecretValue(parsed.data.credential),
      provider_id: providerId.value,
      updated_at: now,
      user_id: user.id,
    },
    { onConflict: "user_id,provider_id" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  try {
    const providers = await listOpenCodeProviderCredentialMeta(admin, user.id);
    const saved = providers.find((item) => item.providerId === providerId.value);
    return NextResponse.json({
      checkedAt: new Date().toISOString(),
      providerId: providerId.value,
      providers,
      updatedAt: saved?.updatedAt ?? now,
    });
  } catch (loadError) {
    const message =
      loadError instanceof Error ? loadError.message : "Failed to load OpenCode provider keys.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { providerId: rawProviderId } = await context.params;
  const providerId = parseOpenCodeProviderId(decodeURIComponent(rawProviderId));
  if (!providerId.ok) {
    return NextResponse.json({ error: providerId.error }, { status: 400 });
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from("user_opencode_provider_credentials")
    .delete()
    .eq("user_id", user.id)
    .eq("provider_id", providerId.value);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}
