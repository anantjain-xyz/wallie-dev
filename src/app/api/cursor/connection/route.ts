import { NextResponse } from "next/server";
import { z } from "zod";

import type { CursorConnectionStatus } from "@/lib/cursor/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const startSchema = z.object({
  workspaceId: z.string().uuid().optional(),
});

export async function GET(request: Request) {
  const auth = await authenticatedUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const flowId = new URL(request.url).searchParams.get("flowId");
  const admin = createSupabaseAdminClient();

  if (flowId) {
    const { data, error } = await admin
      .from("cursor_auth_flows")
      .select("id, status, login_url, error_message, expires_at")
      .eq("id", flowId)
      .eq("user_id", auth.userId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "Sign-in flow not found." }, { status: 404 });
    return NextResponse.json({
      error: data.error_message,
      expiresAt: data.expires_at,
      flowId: data.id,
      loginUrl: data.login_url,
      status: data.status,
    });
  }

  const { data, error } = await admin
    .from("user_cursor_credentials")
    .select("account_email, api_key_expires_at, reconnect_required, reconnect_reason, updated_at")
    .eq("user_id", auth.userId)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(connectionStatus(data));
}

export async function POST(request: Request) {
  const auth = await authenticatedUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = startSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid workspace." }, { status: 400 });
  }

  if (parsed.data.workspaceId) {
    const { data: member } = await auth.supabase
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", parsed.data.workspaceId)
      .eq("user_id", auth.userId)
      .eq("is_active", true)
      .maybeSingle();
    if (!member) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  }

  const admin = createSupabaseAdminClient();
  await admin
    .from("cursor_auth_flows")
    .update({ canceled_at: new Date().toISOString(), status: "canceled" })
    .eq("user_id", auth.userId)
    .in("status", ["starting", "processing", "prompted"]);

  const { data, error } = await admin
    .from("cursor_auth_flows")
    .insert({ user_id: auth.userId, workspace_id: parsed.data.workspaceId ?? null })
    .select("id, status, expires_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    { expiresAt: data.expires_at, flowId: data.id, status: data.status },
    { status: 202 },
  );
}

export async function DELETE(request: Request) {
  const auth = await authenticatedUser();
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const flowId = new URL(request.url).searchParams.get("flowId");
  const admin = createSupabaseAdminClient();
  if (flowId) {
    const { error } = await admin
      .from("cursor_auth_flows")
      .update({ canceled_at: new Date().toISOString(), status: "canceled" })
      .eq("id", flowId)
      .eq("user_id", auth.userId)
      .in("status", ["starting", "processing", "prompted"]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    await admin
      .from("cursor_auth_flows")
      .update({ canceled_at: new Date().toISOString(), status: "canceled" })
      .eq("user_id", auth.userId)
      .in("status", ["starting", "processing", "prompted"]);
    const { error } = await admin
      .from("user_cursor_credentials")
      .delete()
      .eq("user_id", auth.userId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return new NextResponse(null, { status: 204 });
}

async function authenticatedUser() {
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);
  return user ? { supabase, userId: user.id } : null;
}

function connectionStatus(
  data: {
    account_email: string | null;
    api_key_expires_at: string;
    reconnect_reason: string | null;
    reconnect_required: boolean;
    updated_at: string;
  } | null,
): CursorConnectionStatus {
  const checkedAt = new Date().toISOString();
  if (!data) return { checkedAt, connected: false };
  const expired = Date.parse(data.api_key_expires_at) <= Date.now();
  return {
    accountEmail: data.account_email,
    checkedAt,
    connected: !expired && !data.reconnect_required,
    expired,
    expiresAt: data.api_key_expires_at,
    reconnectReason: data.reconnect_reason,
    reconnectRequired: data.reconnect_required,
    updatedAt: data.updated_at,
  };
}
