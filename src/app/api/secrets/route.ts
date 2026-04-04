import { NextRequest, NextResponse } from "next/server";

import {
  listWorkspaceSecretsQuerySchema,
  type ListWorkspaceSecretsResponse,
  type UpsertWorkspaceSecretResponse,
  upsertWorkspaceSecretSchema,
} from "@/lib/secrets/contracts";
import { buildSecretPreview, encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

function mapSecretPreview(row: {
  created_at: string;
  created_by_member_id: string | null;
  id: string;
  key: string;
  updated_at: string;
  value_preview: string | null;
  workspace_id: string;
}) {
  return {
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
    id: row.id,
    key: row.key,
    updatedAt: row.updated_at,
    valuePreview: row.value_preview,
    workspaceId: row.workspace_id,
  };
}

export async function GET(request: NextRequest) {
  const parsed = listWorkspaceSecretsQuerySchema.safeParse({
    workspaceId: request.nextUrl.searchParams.get("workspaceId"),
  });

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Workspace id is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json(
      {
        error: access.error,
      },
      { status: access.status },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspace_secrets")
    .select("id, key, workspace_id, value_preview, created_by_member_id, created_at, updated_at")
    .eq("workspace_id", access.context.workspace.id)
    .order("key", { ascending: true });

  if (error) {
    throw error;
  }

  const response: ListWorkspaceSecretsResponse = {
    secrets: (data ?? []).map(mapSecretPreview),
  };

  return NextResponse.json(response, { status: 200 });
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = upsertWorkspaceSecretSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Secret input is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json(
      {
        error: access.error,
      },
      { status: access.status },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: existingSecret, error: existingSecretError } = await admin
    .from("workspace_secrets")
    .select("id, created_at, created_by_member_id")
    .eq("workspace_id", access.context.workspace.id)
    .eq("key", parsed.data.key)
    .maybeSingle();

  if (existingSecretError) {
    throw existingSecretError;
  }

  const { data, error } = await admin
    .from("workspace_secrets")
    .upsert(
      {
        created_by_member_id:
          existingSecret?.created_by_member_id ?? access.context.currentMember.id,
        encrypted_value: encryptSecretValue(parsed.data.value),
        id: existingSecret?.id,
        key: parsed.data.key,
        value_preview: buildSecretPreview(parsed.data.value),
        workspace_id: access.context.workspace.id,
      },
      {
        onConflict: "workspace_id,key",
      },
    )
    .select("id, key, workspace_id, value_preview, created_by_member_id, created_at, updated_at")
    .single();

  if (error) {
    throw error;
  }

  const response: UpsertWorkspaceSecretResponse = {
    secret: mapSecretPreview(data),
  };

  return NextResponse.json(response, {
    status: existingSecret ? 200 : 201,
  });
}
