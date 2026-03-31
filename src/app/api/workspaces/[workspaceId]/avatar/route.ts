import { NextResponse } from "next/server";

import { workspaceAvatarParamsSchema } from "@/lib/storage/contracts";
import {
  buildWorkspaceAvatarPath,
  getWorkspaceAvatarUrl,
  validateWorkspaceAvatarFile,
  workspaceAvatarBucket,
} from "@/lib/storage/workspace-avatar";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type WorkspaceAvatarRouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

export async function POST(
  request: Request,
  context: WorkspaceAvatarRouteContext,
) {
  const params = await context.params;
  const parsedParams = workspaceAvatarParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    const firstIssue = parsedParams.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Workspace id is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId, {
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

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        error: "Select an image file before uploading a workspace avatar.",
      },
      { status: 400 },
    );
  }

  try {
    validateWorkspaceAvatarFile(file);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Avatar upload is invalid.",
      },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const nextAvatarPath = buildWorkspaceAvatarPath(access.context.workspace.id, file);
  const uploadResult = await admin.storage
    .from(workspaceAvatarBucket)
    .upload(nextAvatarPath, Buffer.from(await file.arrayBuffer()), {
      contentType: file.type,
      upsert: false,
    });

  if (uploadResult.error) {
    throw uploadResult.error;
  }

  const { error: updateError } = await admin
    .from("workspaces")
    .update({
      avatar_path: nextAvatarPath,
    })
    .eq("id", access.context.workspace.id);

  if (updateError) {
    await admin.storage.from(workspaceAvatarBucket).remove([nextAvatarPath]);
    throw updateError;
  }

  if (
    access.context.workspace.avatar_path &&
    access.context.workspace.avatar_path !== nextAvatarPath
  ) {
    await admin.storage
      .from(workspaceAvatarBucket)
      .remove([access.context.workspace.avatar_path]);
  }

  return NextResponse.json(
    {
      avatarPath: nextAvatarPath,
      avatarUrl: getWorkspaceAvatarUrl(nextAvatarPath),
    },
    { status: 200 },
  );
}
