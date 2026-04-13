import { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";
import { generateApiKey } from "@/lib/api-keys/auth";

const createSchema = z.object({
  name: z.string().min(1).max(100).default("Default"),
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

const listSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type ApiKeyPreview = {
  createdAt: string;
  id: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  name: string;
  revokedAt: string | null;
};

export type ListApiKeysResponse = { keys: ApiKeyPreview[] };
export type CreateApiKeyResponse = { key: ApiKeyPreview; rawKey: string };

export async function GET(request: NextRequest) {
  const parsed = listSchema.safeParse({
    workspaceId: request.nextUrl.searchParams.get("workspaceId"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspace_api_keys")
    .select("id, name, key_prefix, last_used_at, created_at, revoked_at")
    .eq("workspace_id", access.context.workspace.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const keys: ApiKeyPreview[] = (data ?? []).map((row) => ({
    createdAt: row.created_at,
    id: row.id,
    keyPrefix: row.key_prefix,
    lastUsedAt: row.last_used_at,
    name: row.name,
    revokedAt: row.revoked_at,
  }));

  return NextResponse.json({ keys } satisfies ListApiKeysResponse);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const { keyHash, keyPrefix, rawKey } = generateApiKey();

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspace_api_keys")
    .insert({
      created_by_member_id: access.context.currentMember.id,
      key_hash: keyHash,
      key_prefix: keyPrefix,
      name: parsed.data.name,
      workspace_id: access.context.workspace.id,
    })
    .select("id, name, key_prefix, last_used_at, created_at, revoked_at")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const key: ApiKeyPreview = {
    createdAt: data.created_at,
    id: data.id,
    keyPrefix: data.key_prefix,
    lastUsedAt: data.last_used_at,
    name: data.name,
    revokedAt: data.revoked_at,
  };

  return NextResponse.json({ key, rawKey } satisfies CreateApiKeyResponse, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const keyId = request.nextUrl.searchParams.get("keyId");
  const workspaceId = request.nextUrl.searchParams.get("workspaceId");

  if (!keyId || !workspaceId) {
    return NextResponse.json({ error: "keyId and workspaceId are required." }, { status: 400 });
  }

  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from("workspace_api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .eq("workspace_id", access.context.workspace.id)
    .is("revoked_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ revoked: true });
}
