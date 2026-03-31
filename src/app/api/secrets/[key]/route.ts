import { NextRequest, NextResponse } from "next/server";

import { listWorkspaceSecretsQuerySchema } from "@/lib/secrets/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type SecretRouteContext = {
  params: Promise<{
    key: string;
  }>;
};

export async function DELETE(request: NextRequest, context: SecretRouteContext) {
  const params = await context.params;
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
  const secretKey = decodeURIComponent(params.key);
  const { data, error } = await admin
    .from("workspace_secrets")
    .delete()
    .eq("workspace_id", access.context.workspace.id)
    .eq("key", secretKey)
    .select("id")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return NextResponse.json(
      {
        error: "Secret not found.",
      },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      deletedKey: secretKey,
    },
    { status: 200 },
  );
}
