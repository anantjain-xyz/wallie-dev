import { NextResponse } from "next/server";

import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { handleApproval, handleRejection } from "@/lib/pipeline/processor";

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
    .select("id, workspace_id, phase_status")
    .eq("id", sessionId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!sessionRow) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (sessionRow.phase_status !== "awaiting_review") {
    return NextResponse.json({ error: "Session is not awaiting review." }, { status: 409 });
  }

  // Resolve the approving workspace member so approve_session_phase can
  // record it in session_phase_completions.completed_by_member_id.
  const { data: memberRow } = await supabase
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", sessionRow.workspace_id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (body.action === "approve") {
    const result = await handleApproval({
      approverMemberId: memberRow?.id ?? null,
      expectedWorkspaceId: sessionRow.workspace_id,
      sessionId: sessionRow.id,
      version: body.version,
    });
    if (!result.success) {
      return NextResponse.json({ error: result.error ?? "Approval failed" }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  }

  if (body.action === "reject") {
    const feedbackText = (body.feedbackText ?? "").trim();
    if (!feedbackText) {
      return NextResponse.json({ error: "Feedback is required" }, { status: 400 });
    }
    const result = await handleRejection({
      expectedWorkspaceId: sessionRow.workspace_id,
      feedbackText,
      sessionId: sessionRow.id,
      version: body.version,
    });
    if (!result.success) {
      return NextResponse.json({ error: result.error ?? "Rejection failed" }, { status: 409 });
    }
    return NextResponse.json({ escalated: result.escalated, success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
