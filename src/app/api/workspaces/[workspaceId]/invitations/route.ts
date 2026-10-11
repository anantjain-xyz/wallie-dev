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

import {
  invitationSelect,
  saveInvitationForDelivery,
  undoInvitationDelivery,
} from "@/lib/workspace-invitations/persistence";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
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
  const { email, fullName, role } = parsed.data;

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
    full_name: fullName,
    invited_by_member_id: access.context.currentMember.id,
    last_sent_at: now,
    role,
    token_hash: tokenHash,
  };

  const savedInvitation = await saveInvitationForDelivery({
    admin,
    email,
    fields: invitationMutation,
    previous: existingInvitation,
    workspaceId: access.context.workspace.id,
  });

  if (!savedInvitation) {
    return NextResponse.json(
      { error: "That invitation changed. Refresh and try again." },
      { status: 409 },
    );
  }

  try {
    await sendWorkspaceInvitationEmail({
      acceptUrl: buildWorkspaceInvitationAcceptUrl(token),
      admin,
      email,
    });
  } catch (error) {
    await undoInvitationDelivery({ admin, previous: existingInvitation, saved: savedInvitation });

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
