import { NextResponse } from "next/server";

import { resolveAuthenticatedHomePath } from "@/lib/auth";
import { workspaceAvatarBucket } from "@/lib/storage/workspace-avatar";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { stopWorkspaceProviderSandboxes } from "@/lib/vercel-sandbox/teardown";
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

  // Stop any provider sandbox an active run or capability check still owns
  // BEFORE the delete. The cascade below drops the run records AND the Vercel
  // connection credentials together, so once the workspace is gone the reaper
  // has neither the sandbox IDs nor the token it needs to reach the provider —
  // a sandbox still running when the processor's `finally` never fired would be
  // orphaned. Best-effort by design: it never throws, so cleanup trouble can't
  // block a delete the owner explicitly confirmed.
  await stopWorkspaceProviderSandboxes(admin, access.context.workspace.id);

  // Hard delete: every workspace-scoped table references workspaces with
  // ON DELETE CASCADE, so removing this row revokes all access and tears down
  // members, pipelines, sessions, artifacts, secrets, and integrations in one
  // shot. Service role bypasses RLS for the write.
  const { error: deleteError } = await admin
    .from("workspaces")
    .delete()
    .eq("id", access.context.workspace.id);

  if (deleteError) {
    return NextResponse.json({ error: "Failed to delete workspace." }, { status: 500 });
  }

  // The FK cascade drops the `workspaces` row and its children, but avatar
  // uploads live in the public `workspace-avatars` storage bucket and only their
  // object path is referenced from the row — so the cascade can't reach them.
  // Best-effort delete every object under this workspace's prefix (re-uploads
  // leave older objects behind, so list rather than relying on avatar_path) so a
  // deleted workspace's avatar isn't left publicly fetchable. Storage failures
  // must not surface as a delete error: the workspace is already gone.
  await removeWorkspaceAvatars(admin, access.context.workspace.id);

  // Resolve where the now-workspaceless (or fewer-workspace) user should land.
  // The RLS-scoped server client no longer sees the deleted workspace, so this
  // returns their next workspace or the onboarding path.
  const redirectTo = await resolveAuthenticatedHomePath(access.context.supabase);

  return NextResponse.json({ deleted: true, redirectTo }, { status: 200 });
}

async function removeWorkspaceAvatars(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  workspaceId: string,
) {
  try {
    const bucket = admin.storage.from(workspaceAvatarBucket);
    const { data: objects } = await bucket.list(workspaceId);

    if (objects && objects.length > 0) {
      await bucket.remove(objects.map((object) => `${workspaceId}/${object.name}`));
    }
  } catch {
    // Best-effort cleanup: the workspace row is already deleted, so a storage
    // failure here should not turn a successful delete into an error response.
  }
}
