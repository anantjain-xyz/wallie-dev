import { NextRequest, NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { authenticateApiKey } from "@/lib/api-keys/auth";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/sessions/:id — Session detail.
 *
 * Returns the session with its artifacts, phase completions, pull requests,
 * and recent agent runs.
 *
 * Authentication: Bearer <workspace_api_key>
 */
export async function GET(request: NextRequest, { params }: Params) {
  const auth = await authenticateApiKey(request);
  if (!auth) {
    return NextResponse.json(
      { error: "Invalid or missing API key. Use Authorization: Bearer wk_<key>" },
      { status: 401 },
    );
  }

  const { id } = await params;
  const admin = createSupabaseAdminClient();

  // Load session.
  const { data: session, error: sessionError } = await admin
    .from("sessions")
    .select(
      "id, number, title, prompt_md, phase, phase_status, current_artifact_version, rejection_count, linear_issue_id, linear_issue_url, slack_channel_id, slack_thread_ts, created_at, updated_at, archived_at",
    )
    .eq("id", id)
    .eq("workspace_id", auth.workspaceId)
    .maybeSingle();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 500 });
  }
  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  // Load related data in parallel.
  const [{ data: artifacts }, { data: completions }, { data: pullRequests }, { data: runs }] =
    await Promise.all([
      admin
        .from("session_artifacts")
        .select("phase, version, created_at")
        .eq("session_id", id)
        .order("version", { ascending: false }),
      admin.from("session_phase_completions").select("phase, completed_at").eq("session_id", id),
      admin
        .from("session_pull_requests")
        .select(
          "branch_name, pull_request_number, pull_request_url, pull_request_state, is_draft, created_at, updated_at",
        )
        .eq("session_id", id)
        .order("created_at", { ascending: false }),
      admin
        .from("agent_runs")
        .select(
          "id, run_type, model_name, status, input_tokens, output_tokens, total_cost_usd, started_at, finished_at, created_at",
        )
        .eq("workspace_id", auth.workspaceId)
        .or(`agent_job_id.in.(select id from agent_jobs where session_id = '${id}')`)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  return NextResponse.json({
    session: {
      id: session.id,
      number: session.number,
      title: session.title,
      promptMd: session.prompt_md,
      phase: session.phase,
      phaseStatus: session.phase_status,
      currentArtifactVersion: session.current_artifact_version,
      rejectionCount: session.rejection_count,
      linearIssueId: session.linear_issue_id,
      linearIssueUrl: session.linear_issue_url,
      slackChannelId: session.slack_channel_id,
      slackThreadTs: session.slack_thread_ts,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
      archivedAt: session.archived_at,
    },
    artifacts: (artifacts ?? []).map((a) => ({
      phase: a.phase,
      version: a.version,
      createdAt: a.created_at,
    })),
    phaseCompletions: (completions ?? []).map((c) => ({
      phase: c.phase,
      completedAt: c.completed_at,
    })),
    pullRequests: (pullRequests ?? []).map((pr) => ({
      branchName: pr.branch_name,
      pullRequestNumber: pr.pull_request_number,
      pullRequestUrl: pr.pull_request_url,
      pullRequestState: pr.pull_request_state,
      isDraft: pr.is_draft,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
    })),
    runs: (runs ?? []).map((r) => ({
      id: r.id,
      runType: r.run_type,
      modelName: r.model_name,
      status: r.status,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      totalCostUsd: r.total_cost_usd,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      createdAt: r.created_at,
    })),
  });
}
