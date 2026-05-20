import { after, NextResponse } from "next/server";

import {
  createSessionPayloadSchema,
  normalizeCreateSessionPayload,
} from "@/features/sessions/create";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildAgentRunActionErrorResponse } from "@/lib/wallie/http";
import { enqueueWallieRun, processQueuedAgentJobs } from "@/lib/wallie/service";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

async function cleanupCreatedSession(input: {
  admin: ReturnType<typeof createSupabaseAdminClient>;
  sessionId: string;
}): Promise<string | null> {
  const { error } = await input.admin.from("sessions").delete().eq("id", input.sessionId);

  if (error) {
    console.error("Failed to clean up session after enqueue failure", {
      error,
      sessionId: input.sessionId,
    });
    return error.message;
  }

  return null;
}

function scheduleQueuedJob(jobId: string | null | undefined) {
  if (!jobId) {
    return;
  }

  after(async () => {
    try {
      await processQueuedAgentJobs({
        requestedJobId: jobId,
      });
    } catch (error) {
      console.error("Wallie initial session processing failed", {
        error,
        jobId,
      });
    }
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return fallback;
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = createSessionPayloadSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Session input is invalid.",
      },
      { status: 400 },
    );
  }

  const normalized = normalizeCreateSessionPayload(parsed.data);
  const access = await requireWorkspaceAccessById(normalized.workspaceId);

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const { data: onboardingRow, error: onboardingError } = await access.context.supabase
    .from("workspace_onboarding")
    .select("status")
    .eq("workspace_id", normalized.workspaceId)
    .maybeSingle();
  if (onboardingError) {
    return NextResponse.json({ error: onboardingError.message }, { status: 500 });
  }
  if (onboardingRow?.status !== "completed") {
    return NextResponse.json(
      { error: "Complete workspace setup before starting a session." },
      { status: 409 },
    );
  }

  const { data: number, error: numberError } = await access.context.supabase.rpc(
    "next_session_number",
    {
      target_workspace_id: normalized.workspaceId,
    },
  );
  if (numberError) {
    return NextResponse.json({ error: numberError.message }, { status: 500 });
  }

  const { data: pipelineRow, error: pipelineError } = await access.context.supabase
    .from("pipelines")
    .select("id")
    .eq("workspace_id", normalized.workspaceId)
    .eq("is_default", true)
    .maybeSingle();
  if (pipelineError) {
    return NextResponse.json({ error: pipelineError.message }, { status: 500 });
  }
  if (!pipelineRow) {
    return NextResponse.json(
      { error: "Workspace has no default pipeline configured." },
      { status: 409 },
    );
  }

  const { data: firstStageRow, error: stageError } = await access.context.supabase
    .from("pipeline_stages")
    .select("id")
    .eq("pipeline_id", pipelineRow.id)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (stageError) {
    return NextResponse.json({ error: stageError.message }, { status: 500 });
  }
  if (!firstStageRow) {
    return NextResponse.json(
      { error: "Default pipeline has no stages configured." },
      { status: 409 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: sessionRow, error: sessionError } = await admin
    .from("sessions")
    .insert({
      creator_member_id: access.context.currentMember.id,
      current_stage_id: firstStageRow.id,
      linear_issue_id: normalized.linearIssueId,
      linear_issue_url: normalized.linearIssueUrl,
      number,
      phase_status: "agent_generating",
      pipeline_id: pipelineRow.id,
      prompt_md: normalized.promptMd,
      title: normalized.title,
      workspace_id: normalized.workspaceId,
    })
    .select("id, number")
    .single();

  if (sessionError || !sessionRow) {
    return NextResponse.json(
      { error: sessionError?.message ?? "Wallie could not create that session." },
      { status: 500 },
    );
  }

  try {
    const result = await enqueueWallieRun({
      admin,
      requestedByMemberId: access.context.currentMember.id,
      sessionId: sessionRow.id,
      supabase: access.context.supabase,
      triggerType: "assignment",
      workspace: access.context.workspace,
    });

    scheduleQueuedJob(result.jobId);

    return NextResponse.json(
      {
        number: sessionRow.number,
        processScheduled: result.created && result.jobId !== null,
      },
      { status: 201 },
    );
  } catch (error) {
    const cleanupError = await cleanupCreatedSession({ admin, sessionId: sessionRow.id });
    let response;
    try {
      response = buildAgentRunActionErrorResponse(error);
    } catch {
      response = {
        body: {
          error: getErrorMessage(error, "Wallie could not queue the first run."),
        },
        status: 500,
      };
    }

    if (cleanupError) {
      return NextResponse.json(
        {
          ...response.body,
          error: `Wallie could not queue the first run, and the created session could not be cleaned up: ${cleanupError}`,
          sessionId: sessionRow.id,
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        ...response.body,
        error: `Session was not created because Wallie could not queue the first run: ${response.body.error}`,
      },
      { status: response.status },
    );
  }
}
