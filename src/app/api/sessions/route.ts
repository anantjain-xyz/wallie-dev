import { after, NextResponse } from "next/server";

import {
  createSessionPayloadSchema,
  normalizeCreateSessionPayload,
} from "@/features/sessions/create";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildAgentRunActionErrorResponse } from "@/lib/wallie/http";
import { enqueueWallieRun, processQueuedAgentJobs } from "@/lib/wallie/service";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

async function cleanupCreatedSession(input: {
  admin: AdminClient;
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

async function loadDefaultSessionRepositoryId(input: {
  admin: AdminClient;
  onboardingRepositoryId: string | null;
  workspaceId: string;
}): Promise<string | null> {
  const [
    { data: primaryProfileRow, error: primaryProfileError },
    { data: repositoryRows, error: repositoriesError },
  ] = await Promise.all([
    input.admin
      .from("workspace_repository_profiles")
      .select("github_repository_id")
      .eq("workspace_id", input.workspaceId)
      .eq("is_primary", true)
      .maybeSingle(),
    input.admin
      .from("github_repositories")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .eq("is_archived", false)
      .order("full_name", { ascending: true }),
  ]);

  if (primaryProfileError) {
    throw primaryProfileError;
  }
  if (repositoriesError) {
    throw repositoriesError;
  }

  const repositoryIds = (repositoryRows ?? []).map((row) => row.id);
  const availableRepositoryIds = new Set(repositoryIds);
  const primaryRepositoryId = primaryProfileRow?.github_repository_id ?? null;

  if (primaryRepositoryId && availableRepositoryIds.has(primaryRepositoryId)) {
    return primaryRepositoryId;
  }

  if (input.onboardingRepositoryId && availableRepositoryIds.has(input.onboardingRepositoryId)) {
    return input.onboardingRepositoryId;
  }

  return repositoryIds[0] ?? null;
}

async function validateSessionRepositoryId(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
}): Promise<boolean> {
  const { data, error } = await input.admin
    .from("github_repositories")
    .select("id")
    .eq("id", input.repositoryId)
    .eq("workspace_id", input.workspaceId)
    .eq("is_archived", false)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return Boolean(data);
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
    .select("status, selected_github_repository_id")
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

  const admin = createSupabaseAdminClient();
  let githubRepositoryId: string | null = null;
  try {
    if (normalized.githubRepositoryId) {
      const repositoryAvailable = await validateSessionRepositoryId({
        admin,
        repositoryId: normalized.githubRepositoryId,
        workspaceId: normalized.workspaceId,
      });

      if (!repositoryAvailable) {
        return NextResponse.json(
          { error: "Repository is not available for this workspace." },
          { status: 400 },
        );
      }

      githubRepositoryId = normalized.githubRepositoryId;
    } else {
      githubRepositoryId = await loadDefaultSessionRepositoryId({
        admin,
        onboardingRepositoryId: onboardingRow.selected_github_repository_id,
        workspaceId: normalized.workspaceId,
      });
    }
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error, "Wallie could not resolve a session repository.") },
      { status: 500 },
    );
  }

  const { data: number, error: numberError } = await admin.rpc("next_session_number", {
    actor_user_id: access.context.user.id,
    target_workspace_id: normalized.workspaceId,
  });
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

  const { data: sessionRow, error: sessionError } = await admin
    .from("sessions")
    .insert({
      creator_member_id: access.context.currentMember.id,
      current_stage_id: firstStageRow.id,
      github_repository_id: githubRepositoryId,
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
