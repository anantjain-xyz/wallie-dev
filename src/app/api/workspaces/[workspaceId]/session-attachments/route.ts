import { NextResponse } from "next/server";

import {
  sessionAttachmentWorkspaceParamsSchema,
  type SessionAttachmentMimeType,
  type SessionAttachmentUploadResponse,
} from "@/lib/storage/contracts";
import {
  createSessionAttachmentIdentity,
  normalizeSessionAttachmentFileName,
  sessionAttachmentBucket,
  sessionAttachmentExpiryMs,
  validateSessionAttachmentFile,
} from "@/lib/storage/session-attachment";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const parsedParams = sessionAttachmentWorkspaceParamsSchema.safeParse(await context.params);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: parsedParams.error.issues[0]?.message ?? "Workspace id is invalid." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Select an image before uploading a session attachment." },
      { status: 400 },
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    validateSessionAttachmentFile(file, bytes);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Session image is invalid." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const identity = createSessionAttachmentIdentity(access.context.workspace.id, file.type);
  const fileName = normalizeSessionAttachmentFileName(file.name, file.type);
  const { error: uploadError } = await admin.storage
    .from(sessionAttachmentBucket)
    .upload(identity.storagePath, bytes, {
      cacheControl: "3600",
      contentType: file.type,
      upsert: false,
    });

  if (uploadError) {
    return NextResponse.json({ error: "Wallie could not store that image." }, { status: 500 });
  }

  const { error: insertError } = await admin.from("session_attachments").insert({
    content_type: file.type,
    expires_at: new Date(Date.now() + sessionAttachmentExpiryMs).toISOString(),
    id: identity.id,
    original_filename: fileName,
    size_bytes: bytes.length,
    status: "ready",
    storage_path: identity.storagePath,
    uploaded_by_member_id: access.context.currentMember.id,
    workspace_id: access.context.workspace.id,
  });

  if (insertError) {
    await admin.storage.from(sessionAttachmentBucket).remove([identity.storagePath]);
    return NextResponse.json(
      { error: "Wallie could not prepare that image for the session." },
      { status: 500 },
    );
  }

  return NextResponse.json<SessionAttachmentUploadResponse>(
    {
      contentType: file.type as SessionAttachmentMimeType,
      fileName,
      id: identity.id,
      sizeBytes: bytes.length,
    },
    { status: 201 },
  );
}
