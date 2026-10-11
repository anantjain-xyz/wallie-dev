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

import {
  invitationSelect,
  saveInvitationForDelivery,
  undoInvitationDelivery,
} from "@/lib/workspace-invitations/persistence";

type RouteContext = {
  params: Promise<{
    invitationId: string;
    workspaceId: string;
  }>;
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
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

  const token = createWorkspaceInvitationToken();
  const savedInvitation = await saveInvitationForDelivery({
    admin,
    email: existingInvitation.email,
    fields: {
      expires_at: workspaceInvitationExpiresAt().toISOString(),
      full_name: existingInvitation.full_name,
      invited_by_member_id: access.context.currentMember.id,
      last_sent_at: new Date().toISOString(),
      role: existingInvitation.role,
      token_hash: hashWorkspaceInvitationToken(token),
    },
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
      email: existingInvitation.email,
    });
  } catch (error) {
    await undoInvitationDelivery({ admin, previous: existingInvitation, saved: savedInvitation });

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
