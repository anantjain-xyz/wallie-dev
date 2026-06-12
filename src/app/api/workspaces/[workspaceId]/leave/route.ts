import { NextResponse } from "next/server";

import { resolveAuthenticatedHomePath } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  mapWorkspaceMemberSummaryRow,
  type WorkspaceMemberResponse,
} from "@/lib/workspace-members/contracts";
import { workspaceIdParamsSchema } from "@/lib/workspaces";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type LeaveRouteContext = {
  params: Promise<{
    workspaceId: string;
  }>;
};

/**
 * Self-removal: the current member leaves the workspace. This reuses the same
 * `remove_workspace_member` RPC that the member-management routes use, so a
 * member who leaves is soft-removed (access revoked immediately) and pruned from
 * any pipeline stage approver lists in one transaction.
 *
 * Owners cannot leave — ownership transfer is out of scope, so the owner must
 * delete the workspace instead. The RPC itself refuses owner rows; we surface a
 * clear 403 before calling it.
 */
export async function POST(_request: Request, context: LeaveRouteContext) {
  const params = await context.params;
  const parsedParams = workspaceIdParamsSchema.safeParse(params);

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

  if (access.context.currentMember.role === "owner") {
    return NextResponse.json(
      { error: "The workspace owner cannot leave. Delete the workspace instead." },
      { status: 403 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("remove_workspace_member", {
    expected_workspace_id: access.context.workspace.id,
    target_member_id: access.context.currentMember.id,
  });

  if (error) {
    throw error;
  }

  const removed = data?.[0];

  if (!removed) {
    return NextResponse.json(
      { error: "You are no longer a member of this workspace." },
      {
        status: 404,
      },
    );
  }

  // After leaving, the RLS-scoped server client no longer counts this workspace,
  // so this resolves to the member's next workspace or the onboarding path.
  const redirectTo = await resolveAuthenticatedHomePath(access.context.supabase);

  const response: WorkspaceMemberResponse & { redirectTo: string } = {
    member: mapWorkspaceMemberSummaryRow(removed),
    redirectTo,
  };

  return NextResponse.json(response, { status: 200 });
}
