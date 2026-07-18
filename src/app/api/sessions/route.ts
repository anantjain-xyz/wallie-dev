import { NextResponse } from "next/server";

import {
  createSessionPayloadSchema,
  normalizeCreateSessionPayload,
} from "@/features/sessions/create";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildAgentRunActionErrorResponse } from "@/lib/wallie/http";
import { createSessionWithFirstJob, prepareSessionFirstRun } from "@/lib/wallie/service";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";
import { workspaceSessionDetailPath } from "@/lib/routes";

export const preferredRegion = "home";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

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

function getErrorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

async function loadAvailableSessionRepositoryId(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
}): Promise<string | null> {
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

  return data?.id ?? null;
}

async function loadFirstAvailableSessionRepositoryId(input: {
  admin: AdminClient;
  workspaceId: string;
}): Promise<string | null> {
  const { data, error } = await input.admin
    .from("github_repositories")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("is_archived", false)
    .order("full_name", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.id ?? null;
}

async function loadDefaultSessionRepositoryId(input: {
  admin: AdminClient;
  onboardingRepositoryId: string | null;
  workspaceId: string;
}): Promise<string | null> {
  const { data: primaryProfileRow, error: primaryProfileError } = await input.admin
    .from("workspace_repository_profiles")
    .select("github_repository_id")
    .eq("workspace_id", input.workspaceId)
    .eq("is_primary", true)
    .maybeSingle();

  if (primaryProfileError) {
    throw primaryProfileError;
  }

  const primaryRepositoryId = primaryProfileRow?.github_repository_id ?? null;
  if (primaryRepositoryId) {
    const repositoryId = await loadAvailableSessionRepositoryId({
      admin: input.admin,
      repositoryId: primaryRepositoryId,
      workspaceId: input.workspaceId,
    });
    if (repositoryId) return repositoryId;
  }

  if (input.onboardingRepositoryId) {
    const repositoryId = await loadAvailableSessionRepositoryId({
      admin: input.admin,
      repositoryId: input.onboardingRepositoryId,
      workspaceId: input.workspaceId,
    });
    if (repositoryId) return repositoryId;
  }

  return loadFirstAvailableSessionRepositoryId(input);
}

async function validateSessionRepositoryId(input: {
  admin: AdminClient;
  repositoryId: string;
  workspaceId: string;
}): Promise<boolean> {
  return Boolean(await loadAvailableSessionRepositoryId(input));
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

  const admin = createSupabaseAdminClient();
  const [onboardingResult, firstRunResult] = await Promise.all([
    access.context.supabase
      .from("workspace_onboarding")
      .select("status, selected_github_repository_id")
      .eq("workspace_id", normalized.workspaceId)
      .maybeSingle(),
    prepareSessionFirstRun({ admin, workspaceId: normalized.workspaceId }).then(
      (data) => ({ data, error: null }),
      (error: unknown) => ({ data: null, error }),
    ),
  ]);
  const { data: onboardingRow, error: onboardingError } = onboardingResult;
  if (onboardingError) {
    return NextResponse.json({ error: onboardingError.message }, { status: 500 });
  }
  if (onboardingRow?.status !== "completed") {
    return NextResponse.json(
      { error: "Complete workspace setup before starting a session." },
      { status: 409 },
    );
  }

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

  if (firstRunResult.error || !firstRunResult.data) {
    try {
      const response = buildAgentRunActionErrorResponse(firstRunResult.error);
      return NextResponse.json(response.body, { status: response.status });
    } catch {
      return NextResponse.json(
        { error: getErrorMessage(firstRunResult.error, "Wallie is not ready to run.") },
        { status: 500 },
      );
    }
  }

  try {
    const result = await createSessionWithFirstJob({
      admin,
      creatorMemberId: access.context.currentMember.id,
      githubRepositoryId,
      linearIssueId: normalized.linearIssueId,
      linearIssueUrl: normalized.linearIssueUrl,
      modelName: firstRunResult.data.model,
      modelProvider: firstRunResult.data.provider,
      promptMd: normalized.promptMd,
      title: normalized.title,
      workspaceId: normalized.workspaceId,
    });

    return NextResponse.json(
      {
        canonicalUrl: workspaceSessionDetailPath(result.workspaceSlug, result.number),
        number: result.number,
        processScheduled: Boolean(result.jobId),
      },
      { status: 201 },
    );
  } catch (error) {
    if (getErrorCode(error) === "P0002") {
      return NextResponse.json(
        { error: getErrorMessage(error, "Workspace pipeline is not configured.") },
        { status: 409 },
      );
    }

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

    return NextResponse.json(response.body, { status: response.status });
  }
}
