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

  // Membership check via RLS: the server client can only read pipeline_issues
  // the current user can see through workspace_members. If the caller is not a
  // member, this returns null and we 404.
  const { data: pipelineRow, error: pipelineError } = await supabase
    .from("pipeline_issues")
    .select("id, workspace_id, phase_status")
    .eq("id", sessionId)
    .maybeSingle();

  if (pipelineError) {
    return NextResponse.json({ error: pipelineError.message }, { status: 500 });
  }
  if (!pipelineRow) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (pipelineRow.phase_status !== "awaiting_review") {
    return NextResponse.json({ error: "Session is not awaiting review." }, { status: 409 });
  }

  if (body.action === "approve") {
    const result = await handleApproval({
      expectedWorkspaceId: pipelineRow.workspace_id,
      pipelineIssueId: pipelineRow.id,
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
      expectedWorkspaceId: pipelineRow.workspace_id,
      feedbackText,
      pipelineIssueId: pipelineRow.id,
      version: body.version,
    });
    if (!result.success) {
      return NextResponse.json({ error: result.error ?? "Rejection failed" }, { status: 409 });
    }
    return NextResponse.json({ escalated: result.escalated, success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
