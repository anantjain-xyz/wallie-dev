import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";
import {
  mapWorkspaceMemberSummaryRow,
  updateWorkspaceMemberRoleSchema,
  workspaceMemberActionParamsSchema,
  type WorkspaceMemberResponse,
} from "@/lib/workspace-members/contracts";

type RouteContext = {
  params: Promise<{
    memberId: string;
    workspaceId: string;
  }>;
};

const memberSelect = "id, full_name, email, role";
const targetSelect = "id, role, kind, is_active";

type TargetMember = {
  id: string;
  is_active: boolean;
  kind: "human" | "system";
  role: "owner" | "admin" | "member" | "agent";
};

type ManagerGuard =
  | {
      ok: true;
      admin: ReturnType<typeof createSupabaseAdminClient>;
      memberId: string;
      workspaceId: string;
    }
  | { ok: false; response: NextResponse };

/**
 * Shared front door for the member mutation routes: validate params, require a
 * manager (owner/admin) via RLS-backed access checks, block acting on yourself,
 * and confirm the target is an active human member of this workspace. Returns
 * the admin client (service role) so the actual write can bypass RLS — the
 * `authenticated` role only has `update(preferences)` on `workspace_members`.
 */
async function guardManagedMember(
  rawParams: unknown,
  selfActionMessage: string,
): Promise<ManagerGuard> {
  const parsedParams = workspaceMemberActionParamsSchema.safeParse(rawParams);

  if (!parsedParams.success) {
    const firstIssue = parsedParams.error.issues[0];
    return {
      ok: false,
      response: NextResponse.json(
        { error: firstIssue?.message ?? "Member route input is invalid." },
        { status: 400 },
      ),
    };
  }

  const access = await requireWorkspaceAccessById(parsedParams.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: access.error }, { status: access.status }),
    };
  }

  if (parsedParams.data.memberId === access.context.currentMember.id) {
    return {
      ok: false,
      response: NextResponse.json({ error: selfActionMessage }, { status: 400 }),
    };
  }

  const admin = createSupabaseAdminClient();
  const { data: target, error: targetError } = await admin
    .from("workspace_members")
    .select(targetSelect)
    .eq("id", parsedParams.data.memberId)
    .eq("workspace_id", access.context.workspace.id)
    .maybeSingle<TargetMember>();

  if (targetError) {
    throw targetError;
  }

  if (!target || !target.is_active || target.kind !== "human") {
    return {
      ok: false,
      response: NextResponse.json({ error: "Workspace member not found." }, { status: 404 }),
    };
  }

  if (target.role === "owner") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "The workspace owner cannot be changed or removed here." },
        { status: 403 },
      ),
    };
  }

  return {
    ok: true,
    admin,
    memberId: parsedParams.data.memberId,
    workspaceId: access.context.workspace.id,
  };
}

export async function PATCH(request: Request, context: RouteContext) {
  const guard = await guardManagedMember(await context.params, "You cannot change your own role.");

  if (!guard.ok) {
    return guard.response;
  }

  const payload = await request.json().catch(() => null);
  const parsed = updateWorkspaceMemberRoleSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return NextResponse.json(
      { error: firstIssue?.message ?? "Member role input is invalid." },
      { status: 400 },
    );
  }

  const { data, error } = await guard.admin
    .from("workspace_members")
    .update({ role: parsed.data.role })
    .eq("id", guard.memberId)
    .eq("workspace_id", guard.workspaceId)
    .eq("kind", "human")
    .eq("is_active", true)
    .select(memberSelect)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return NextResponse.json({ error: "Workspace member not found." }, { status: 404 });
  }

  const response: WorkspaceMemberResponse = {
    member: mapWorkspaceMemberSummaryRow(data),
  };

  return NextResponse.json(response, { status: 200 });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const guard = await guardManagedMember(
    await context.params,
    "You cannot remove yourself from the workspace.",
  );

  if (!guard.ok) {
    return guard.response;
  }

  // Soft-remove: flipping `is_active` to false revokes access immediately because
  // `internal.current_user_workspace_ids()` (and every RLS policy built on it)
  // only counts active memberships. It also preserves authorship references on
  // sessions/artifacts that a hard delete would null out.
  const { data, error } = await guard.admin
    .from("workspace_members")
    .update({ is_active: false })
    .eq("id", guard.memberId)
    .eq("workspace_id", guard.workspaceId)
    .eq("kind", "human")
    .eq("is_active", true)
    .select(memberSelect)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return NextResponse.json({ error: "Workspace member not found." }, { status: 404 });
  }

  const response: WorkspaceMemberResponse = {
    member: mapWorkspaceMemberSummaryRow(data),
  };

  return NextResponse.json(response, { status: 200 });
}
