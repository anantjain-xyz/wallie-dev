import { NextResponse } from "next/server";

import { sessionAttachmentParamsSchema } from "@/lib/storage/contracts";
import { sessionAttachmentBucket } from "@/lib/storage/session-attachment";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ attachmentId: string; workspaceId: string }>;
};

export async function DELETE(_request: Request, context: RouteContext) {
  const parsedParams = sessionAttachmentParamsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: parsedParams.error.issues[0]?.message ?? "Attachment input is invalid." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const deleteClaimedAt = new Date().toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("session_attachments")
    .update({ delete_claimed_at: deleteClaimedAt, status: "deleting" })
    .eq("id", parsedParams.data.attachmentId)
    .eq("workspace_id", access.context.workspace.id)
    .eq("uploaded_by_member_id", access.context.currentMember.id)
    .eq("status", "ready")
    .is("session_id", null)
    .select("id, storage_path")
    .maybeSingle();

  if (claimError) {
    return NextResponse.json({ error: "Wallie could not remove that image." }, { status: 500 });
  }
  if (!claimed) {
    return NextResponse.json({ error: "Session image not found." }, { status: 404 });
  }

  const { error: storageError } = await admin.storage
    .from(sessionAttachmentBucket)
    .remove([claimed.storage_path]);
  if (storageError) {
    await restoreReadyStatus(admin, claimed.id, deleteClaimedAt);
    return NextResponse.json({ error: "Wallie could not remove that image." }, { status: 500 });
  }

  const { error: deleteError } = await admin
    .from("session_attachments")
    .delete()
    .eq("id", claimed.id)
    .eq("status", "deleting")
    .eq("delete_claimed_at", deleteClaimedAt)
    .is("session_id", null);
  if (deleteError) {
    await restoreReadyStatus(admin, claimed.id, deleteClaimedAt);
    return NextResponse.json({ error: "Wallie could not remove that image." }, { status: 500 });
  }

  return new NextResponse(null, { status: 204 });
}

async function restoreReadyStatus(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  attachmentId: string,
  deleteClaimedAt: string,
) {
  await admin
    .from("session_attachments")
    .update({ delete_claimed_at: null, status: "ready" })
    .eq("id", attachmentId)
    .eq("status", "deleting")
    .eq("delete_claimed_at", deleteClaimedAt)
    .is("session_id", null);
}
