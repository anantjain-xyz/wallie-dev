import { NextResponse } from "next/server";

import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";
import {
  buildWorkspaceInvitationAcceptUrl,
  createWorkspaceInvitationToken,
  hashWorkspaceInvitationToken,
  sendWorkspaceInvitationEmail,
  workspaceInvitationExpiresAt,
} from "@/lib/workspace-invitations/server";
import {
  createWorkspaceInvitationSchema,
  mapWorkspaceInvitationRow,
  workspaceInvitationParamsSchema,
  type WorkspaceInvitationResponse,
} from "@/lib/workspace-invitations/contracts";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const invitationSelect =
  "id, workspace_id, email, role, status, token_hash, invited_by_member_id, accepted_by_member_id, expires_at, last_sent_at, accepted_at, revoked_at, created_at, updated_at";

type InvitationPersistenceRow = {
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
  status: "accepted" | "pending" | "revoked";
  token_hash: string;
  updated_at: string;
  workspace_id: string;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function restorePendingInvitation(
  admin: ReturnType<typeof createSupabaseAdminClient>,
  invitation: InvitationPersistenceRow,
) {
  await admin
    .from("workspace_invitations")
    .update({
      expires_at: invitation.expires_at,
      invited_by_member_id: invitation.invited_by_member_id,
      last_sent_at: invitation.last_sent_at,
      role: invitation.role,
      token_hash: invitation.token_hash,
    })
    .eq("id", invitation.id);
}

export async function POST(request: Request, context: RouteContext) {
  const parsedParams = workspaceInvitationParamsSchema.safeParse(await context.params);

  if (!parsedParams.success) {
    const firstIssue = parsedParams.error.issues[0];
    return NextResponse.json(
      { error: firstIssue?.message ?? "Workspace id is invalid." },
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

  const payload = await request.json().catch(() => null);
  const parsed = createWorkspaceInvitationSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      { error: firstIssue?.message ?? "Invitation input is invalid." },
      { status: 400 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { email, role } = parsed.data;

  const { data: activeMember, error: activeMemberError } = await admin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", access.context.workspace.id)
    .eq("kind", "human")
    .eq("is_active", true)
    .eq("email", email)
    .maybeSingle();

  if (activeMemberError) {
    throw activeMemberError;
  }

  if (activeMember) {
    return NextResponse.json(
      { error: "That email is already an active member of this workspace." },
      { status: 409 },
    );
  }

  const { data: existingInvitation, error: existingInvitationError } = await admin
    .from("workspace_invitations")
    .select(invitationSelect)
    .eq("workspace_id", access.context.workspace.id)
    .eq("email", email)
    .eq("status", "pending")
    .maybeSingle();

  if (existingInvitationError) {
    throw existingInvitationError;
  }

  const token = createWorkspaceInvitationToken();
  const expiresAt = workspaceInvitationExpiresAt().toISOString();
  const now = new Date().toISOString();
  const tokenHash = hashWorkspaceInvitationToken(token);
  const invitationMutation = {
    expires_at: expiresAt,
    invited_by_member_id: access.context.currentMember.id,
    last_sent_at: now,
    role,
    token_hash: tokenHash,
  };

  const { data: savedInvitation, error: saveError } = existingInvitation
    ? await admin
        .from("workspace_invitations")
        .update(invitationMutation)
        .eq("id", existingInvitation.id)
        .select(invitationSelect)
        .single()
    : await admin
        .from("workspace_invitations")
        .insert({
          ...invitationMutation,
          email,
          status: "pending",
          workspace_id: access.context.workspace.id,
        })
        .select(invitationSelect)
        .single();

  if (saveError) {
    throw saveError;
  }

  try {
    await sendWorkspaceInvitationEmail({
      acceptUrl: buildWorkspaceInvitationAcceptUrl(token),
      admin,
      email,
    });
  } catch (error) {
    if (existingInvitation) {
      await restorePendingInvitation(admin, existingInvitation as InvitationPersistenceRow);
    } else {
      await admin.from("workspace_invitations").delete().eq("id", savedInvitation.id);
    }

    return NextResponse.json(
      { error: errorMessage(error, "Wallie could not send that invitation email.") },
      { status: 502 },
    );
  }

  const response: WorkspaceInvitationResponse = {
    invitation: mapWorkspaceInvitationRow(savedInvitation),
  };

  return NextResponse.json(response, { status: existingInvitation ? 200 : 201 });
}
