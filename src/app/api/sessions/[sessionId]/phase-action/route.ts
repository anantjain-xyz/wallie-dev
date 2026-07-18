import { NextResponse } from "next/server";

import { handleApproval, handleRejection } from "@/lib/pipeline/processor";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

type Params = { params: Promise<{ sessionId: string }> };

type PhaseActionBody = {
  action: "approve" | "reject";
  feedbackText?: string;
  version: number;
};

export async function POST(request: Request, { params }: Params) {
  const { sessionId } = await params;
  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: PhaseActionBody;
  try {
    body = (await request.json()) as PhaseActionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.version !== "number" || Number.isNaN(body.version)) {
    return NextResponse.json({ error: "version must be a number" }, { status: 400 });
  }

  // Membership check via RLS: the server client can only read sessions the
  // current user can see through workspace_members. If the caller is not a
  // member, this returns null and we 404.
  const { data: sessionRow, error: sessionError } = await supabase
    .from("sessions")
    .select("id, workspace_id, phase_status, current_stage_id, archived_at")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!sessionRow) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // An archived session is frozen: approving/rejecting must not advance or
  // re-run it. Block before any RPC mutation.
  if (sessionRow.archived_at) {
    return NextResponse.json({ error: "Session is archived." }, { status: 409 });
  }

  if (sessionRow.phase_status !== "awaiting_review") {
    return NextResponse.json({ error: "Session is not awaiting review." }, { status: 409 });
  }

  const gated = await enforceRateLimit("phaseAction", `${sessionRow.workspace_id}:${user.id}`);
  if (gated.response) {
    return gated.response;
  }

  // Resolve the calling member id so the RPC's approver gate can evaluate it.
  const { data: memberRow } = await supabase
    .from("workspace_members")
    .select("id, role")
    .eq("workspace_id", sessionRow.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!memberRow) {
    return NextResponse.json({ error: "Not a member of this workspace." }, { status: 403 });
  }

  if (body.action === "approve") {
    // Belt-and-suspenders authz check: the RPC enforces this too, but doing it
    // here gives a clearer 403 ("not in approver list") instead of the RPC's
    // generic CAS-miss "stale or already reviewed" message.
    const authError = await checkApproverAuthorization(
      sessionRow.workspace_id,
      sessionRow.current_stage_id,
      memberRow.id,
      memberRow.role,
    );
    if (authError) {
      return NextResponse.json({ error: authError }, { status: 403 });
    }

    const result = await handleApproval({
      approverMemberId: memberRow.id,
      expectedWorkspaceId: sessionRow.workspace_id,
      sessionId: sessionRow.id,
      version: body.version,
    });
    if (!result.success) {
      return NextResponse.json({ error: result.error ?? "Approval failed" }, { status: 409 });
    }
    return NextResponse.json({ session: result.session, success: true });
  }

  if (body.action === "reject") {
    const feedbackText = (body.feedbackText ?? "").trim();
    if (!feedbackText) {
      return NextResponse.json({ error: "Feedback is required" }, { status: 400 });
    }
    const result = await handleRejection({
      expectedWorkspaceId: sessionRow.workspace_id,
      feedbackText,
      requestedByMemberId: memberRow.id,
      sessionId: sessionRow.id,
      version: body.version,
    });
    if (!result.success) {
      return NextResponse.json({ error: result.error ?? "Rejection failed" }, { status: 409 });
    }
    return NextResponse.json({ session: result.session, success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function checkApproverAuthorization(
  workspaceId: string,
  stageId: string,
  memberId: string,
  memberRole: string,
): Promise<string | null> {
  // Use the admin client to read the stage's approver list. RLS would also
  // allow this read for the current user, but using admin keeps a single code
  // path regardless of who the caller is.
  const admin = createSupabaseAdminClient();
  const { data: stage, error } = await admin
    .from("pipeline_stages")
    .select("approver_member_ids, name")
    .eq("id", stageId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) return error.message;
  if (!stage) return "Stage not found.";

  const approvers = stage.approver_member_ids ?? [];
  if (approvers.length > 0) {
    if (!approvers.includes(memberId)) {
      return `You are not authorized to approve the ${stage.name} stage.`;
    }
    return null;
  }

  // Empty list: fall back to workspace owners/admins.
  if (memberRole !== "owner" && memberRole !== "admin") {
    return `Only workspace owners and admins can approve the ${stage.name} stage (no approver list set).`;
  }
  return null;
}
