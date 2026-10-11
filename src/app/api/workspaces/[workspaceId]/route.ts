import { NextResponse } from "next/server";

import { resolveAuthenticatedHomePath } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resumeWorkspaceDeletion } from "@/lib/workspaces/deletion";
import {
  deleteWorkspacePayloadSchema,
  updateWorkspaceNamePayloadSchema,
  workspaceIdParamsSchema,
} from "@/lib/workspaces";
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

export async function DELETE(request: Request, context: WorkspaceRouteContext) {
  const params = await context.params;
  const parsedParams = workspaceIdParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return NextResponse.json(
      { error: parsedParams.error.issues[0]?.message ?? "Workspace id is invalid." },
      { status: 400 },
    );
  }

  const payload = await request.json().catch(() => null);
  const parsedPayload = deleteWorkspacePayloadSchema.safeParse(payload);

  if (!parsedPayload.success) {
    return NextResponse.json(
      { error: parsedPayload.error.issues[0]?.message ?? "Confirmation is required." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId, {
    allowDeleting: true,
    requireOwner: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  // Typed-confirmation guard: the deleter must retype the exact workspace name.
  // The UI enforces this too, but the server is the real gate against an
  // accidental or forged request deleting the wrong workspace.
  if (parsedPayload.data.confirmation.trim() !== access.context.workspace.name) {
    return NextResponse.json(
      { error: "Type the workspace name exactly to confirm deletion." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { error: beginError } = await admin.rpc("begin_workspace_deletion", {
    p_confirmation: parsedPayload.data.confirmation,
    p_owner_member_id: access.context.currentMember.id,
    p_workspace_id: access.context.workspace.id,
  });
  if (beginError) {
    return NextResponse.json(
      { error: "Failed to request workspace deletion." },
      { status: beginError.code === "42501" ? 403 : beginError.code === "22023" ? 400 : 500 },
    );
  }
  // The durable fence is already committed. Any failure keeps credentials and
  // cleanup ownership for the worker or another owner request to retry.
  let deleted = false;
  try {
    deleted = await resumeWorkspaceDeletion(admin, access.context.workspace.id);
  } catch (error) {
    console.error("[workspace-delete] cleanup will retry", {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: access.context.workspace.id,
    });
  }
  if (!deleted) {
    return NextResponse.json(
      {
        deleted: false,
        message:
          "Workspace deletion is in progress. Cleanup will retry automatically; you can also retry here.",
      },
      { status: 202 },
    );
  }

  // Resolve where the now-workspaceless (or fewer-workspace) user should land.
  // The RLS-scoped server client no longer sees the deleted workspace, so this
  // returns their next workspace or the onboarding path.
  const redirectTo = await resolveAuthenticatedHomePath(access.context.supabase);

  return NextResponse.json({ deleted: true, redirectTo }, { status: 200 });
}
