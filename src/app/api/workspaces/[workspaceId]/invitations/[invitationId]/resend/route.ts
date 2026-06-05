import { NextResponse } from "next/server";

import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";
import {
  mapWorkspaceInvitationRow,
  workspaceInvitationActionParamsSchema,
  type WorkspaceInvitationResponse,
} from "@/lib/workspace-invitations/contracts";
import {
  buildWorkspaceInvitationAcceptUrl,
  createWorkspaceInvitationToken,
  hashWorkspaceInvitationToken,
  sendWorkspaceInvitationEmail,
  workspaceInvitationExpiresAt,
} from "@/lib/workspace-invitations/server";

type RouteContext = {
  params: Promise<{
    invitationId: string;
    workspaceId: string;
  }>;
};

const invitationSelect =
  "id, workspace_id, email, role, status, token_hash, invited_by_member_id, accepted_by_member_id, expires_at, last_sent_at, accepted_at, revoked_at, created_at, updated_at";

type PendingInvitationRow = {
  accepted_at: string | null;
  accepted_by_member_id: string | null;
  created_at: string;
  email: string;
  expires_at: string;
  id: string;
  invited_by_member_id: string | null;
  last_sent_at: string | null;
  revoked_at: string | null;
  role: "admin" | "member";
  status: "pending";
  token_hash: string;
  updated_at: string;
  workspace_id: string;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function restorePendingInvitation(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  invitation: PendingInvitationRow,
) {
  await admin
    .from("workspace_invitations")
    .update({
      expires_at: invitation.expires_at,
      invited_by_member_id: invitation.invited_by_member_id,
      last_sent_at: invitation.last_sent_at,
      token_hash: invitation.token_hash,
    })
    .eq("id", invitation.id);
}

export async function POST(request: Request, context: RouteContext) {
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

  const gated = await enforceRateLimit(
    "workspaceInvites",
    `${access.context.workspace.id}:${access.context.currentMember.id}`,
  );
  if (gated.response) {
    return gated.response;
  }

  const admin = createSupabaseAdminClient();
  const { data: existingInvitation, error: existingInvitationError } = await admin
    .from("workspace_invitations")
    .select(invitationSelect)
    .eq("id", parsedParams.data.invitationId)
    .eq("workspace_id", access.context.workspace.id)
    .eq("status", "pending")
    .maybeSingle();

  if (existingInvitationError) {
    throw existingInvitationError;
  }

  if (!existingInvitation) {
    return NextResponse.json({ error: "Pending invitation not found." }, { status: 404 });
  }

  const previousInvitation = existingInvitation as PendingInvitationRow;
  const token = createWorkspaceInvitationToken();
  const { data: savedInvitation, error: saveError } = await admin
    .from("workspace_invitations")
    .update({
      expires_at: workspaceInvitationExpiresAt().toISOString(),
      invited_by_member_id: access.context.currentMember.id,
      last_sent_at: new Date().toISOString(),
      token_hash: hashWorkspaceInvitationToken(token),
    })
    .eq("id", existingInvitation.id)
    .select(invitationSelect)
    .single();

  if (saveError) {
    throw saveError;
  }

  try {
    await sendWorkspaceInvitationEmail({
      acceptUrl: buildWorkspaceInvitationAcceptUrl(request.url, token),
      admin,
      email: existingInvitation.email,
    });
  } catch (error) {
    await restorePendingInvitation(admin, previousInvitation);

    return NextResponse.json(
      { error: errorMessage(error, "Wallie could not resend that invitation email.") },
      { status: 502 },
    );
  }

  const response: WorkspaceInvitationResponse = {
    invitation: mapWorkspaceInvitationRow(savedInvitation),
  };

  return NextResponse.json(response, { status: 200 });
}
