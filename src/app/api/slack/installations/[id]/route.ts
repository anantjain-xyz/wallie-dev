import { NextRequest, NextResponse } from "next/server";

import { deleteSlackInstallationForWorkspace } from "@/features/slack/service";
import { slackWorkspaceQuerySchema } from "@/features/slack/contracts";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const parsed = slackWorkspaceQuerySchema.safeParse({
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

  try {
    await deleteSlackInstallationForWorkspace({
      installationId: id,
      workspaceId: access.context.workspace.id,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to disconnect Slack installation.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ deletedId: id }, { status: 200 });
}
