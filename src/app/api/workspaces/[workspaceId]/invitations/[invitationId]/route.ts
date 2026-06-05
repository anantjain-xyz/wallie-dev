import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";
import {
  mapWorkspaceInvitationRow,
  workspaceInvitationActionParamsSchema,
  type WorkspaceInvitationResponse,
} from "@/lib/workspace-invitations/contracts";

type RouteContext = {
  params: Promise<{
    invitationId: string;
    workspaceId: string;
  }>;
};

const invitationSelect =
  "id, workspace_id, email, role, status, invited_by_member_id, accepted_by_member_id, expires_at, last_sent_at, accepted_at, revoked_at, created_at, updated_at";

export async function DELETE(_request: Request, context: RouteContext) {
  const parsedParams = workspaceInvitationActionParamsSchema.safeParse(await context.params);

  if (!parsedParams.success) {
    const firstIssue = parsedParams.error.issues[0];
    return NextResponse.json(
      { error: firstIssue?.message ?? "Invitation route input is invalid." },
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
  const { data, error } = await admin
    .from("workspace_invitations")
    .update({
      revoked_at: new Date().toISOString(),
      status: "revoked",
    })
    .eq("id", parsedParams.data.invitationId)
    .eq("workspace_id", access.context.workspace.id)
    .eq("status", "pending")
    .select(invitationSelect)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return NextResponse.json({ error: "Pending invitation not found." }, { status: 404 });
  }

  const response: WorkspaceInvitationResponse = {
    invitation: mapWorkspaceInvitationRow(data),
  };

  return NextResponse.json(response, { status: 200 });
}
