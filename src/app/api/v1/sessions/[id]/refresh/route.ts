import { NextRequest, NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api-keys/auth";
import { PIPELINE_JOB_TYPE } from "@/lib/pipeline/types";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/sessions/:id/refresh — Re-trigger processing for a session.
 *
 * Creates a new pipeline job for the session's current phase. This is useful
 * for retrying a stuck or failed session from an external system.
 *
 * Authentication: Bearer <workspace_api_key>
 */
export async function POST(request: NextRequest, { params }: Params) {
  const auth = await authenticateApiKey(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Invalid or missing API key. Use Authorization: Bearer wk_<key>" },
      { status: 401 },
    );
  }

  const { id } = await params;
  const admin = createSupabaseAdminClient();

  // Load session to verify ownership and current state.
  const { data: session, error: sessionError } = await admin
    .from("sessions")
    .select("id, workspace_id, phase, phase_status")
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  if (session.phase_status === "approved") {
    return NextResponse.json({ error: "Session phase is already approved." }, { status: 409 });
  }

  // Load the workspace system member for the requested_by FK.
  const { data: wallieMember } = await admin
    .from("workspace_members")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("kind", "system")
    .eq("username", "wallie")
    .maybeSingle();

  // Enqueue a new pipeline job.
  const { data: job, error: enqueueError } = await admin
    .from("agent_jobs")
    .insert({
      dedupe_key: `pipeline:session:${session.id}:refresh:${Date.now()}`,
      job_type: PIPELINE_JOB_TYPE,
      requested_by_member_id: wallieMember?.id ?? null,
      session_id: session.id,
      trigger_type: "manual_retry" as const,
      workspace_id: auth.workspaceId,
    })
    .select("id, status, created_at")
    .single();

  if (enqueueError) {
    return NextResponse.json({ error: enqueueError.message }, { status: 500 });
  }

  // Flip the session to agent_generating so the processor will pick it up.
  await admin.from("sessions").update({ phase_status: "agent_generating" }).eq("id", session.id);

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    createdAt: job.created_at,
    message: "Session refresh enqueued. The pipeline processor will pick it up.",
  });
}
