import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { updateWorkspaceNamePayloadSchema, workspaceIdParamsSchema } from "@/lib/workspaces";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type WorkspaceRouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function PATCH(request: Request, context: WorkspaceRouteContext) {
  const params = await context.params;
  const parsedParams = workspaceIdParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: parsedParams.error.issues[0]?.message ?? "Workspace id is invalid." },
      { status: 400 },
    );
  }

  const payload = await request.json().catch(() => null);
  const parsedPayload = updateWorkspaceNamePayloadSchema.safeParse(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { error: parsedPayload.error.issues[0]?.message ?? "Workspace name is invalid." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { data: updatedRow, error: updateError } = await admin
    .from("workspaces")
    .update({ name: parsedPayload.data.name })
    .eq("id", access.context.workspace.id)
    .select("id, name, updated_at")
    .single();

  if (updateError || !updatedRow) {
    return NextResponse.json({ error: "Failed to update workspace name." }, { status: 500 });
  }

  return NextResponse.json(
    {
      id: updatedRow.id,
      name: updatedRow.name,
      updatedAt: updatedRow.updated_at,
    },
    { status: 200 },
  );
}
