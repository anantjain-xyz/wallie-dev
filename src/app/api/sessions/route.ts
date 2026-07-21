import { NextResponse } from "next/server";

import {
  createSessionPayloadSchema,
  normalizeCreateSessionPayload,
} from "@/features/sessions/create";
import type { WallieSessionRepository } from "@/features/wallie/types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { buildAgentRunActionErrorResponse } from "@/lib/wallie/http";
import {
  assertSessionFirstRunReady,
  assertSessionSandboxCapabilityReady,
  createSessionWithFirstJob,
  loadSessionFirstRunPrerequisites,
} from "@/lib/wallie/service";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";
import { workspaceSessionDetailPath } from "@/lib/routes";

export const preferredRegion = "home";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

const repositoryPreflightSelect =
  "id, full_name, html_url, private, default_programming_language, default_branch, is_archived";

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

function mapWallieSessionRepository(row: {
  default_branch: string | null;
  default_programming_language: string | null;
  full_name: string;
  html_url: string;
  id: string;
  is_archived: boolean;
  private: boolean;
}): WallieSessionRepository {
  return {
    defaultBranch: row.default_branch,
    defaultProgrammingLanguage: row.default_programming_language,
    fullName: row.full_name,
    htmlUrl: row.html_url,
    id: row.id,
    isArchived: row.is_archived,
    isPrivate: row.private,
  };
}

async function loadSessionRepositoryById(input: {
  admin: AdminClient;
  repositoryId: string;
  requireActive?: boolean;
  workspaceId: string;
}): Promise<WallieSessionRepository | null> {
  let query = input.admin
    .from("github_repositories")
    .select(repositoryPreflightSelect)
    .eq("id", input.repositoryId)
    .eq("workspace_id", input.workspaceId);

  if (input.requireActive) {
    query = query.eq("is_archived", false);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapWallieSessionRepository(data) : null;
}

async function loadFirstAvailableSessionRepository(input: {
  admin: AdminClient;
  workspaceId: string;
}): Promise<WallieSessionRepository | null> {
  const { data, error } = await input.admin
    .from("github_repositories")
    .select(repositoryPreflightSelect)
    .eq("workspace_id", input.workspaceId)
    .eq("is_archived", false)
    .order("full_name", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapWallieSessionRepository(data) : null;
}

async function loadDefaultSessionRepository(input: {
  admin: AdminClient;
  onboardingRepositoryId: string | null;
  workspaceId: string;
}): Promise<{
  configuredRepository: WallieSessionRepository | null;
  sessionRepository: WallieSessionRepository | null;
}> {
  const { data: primaryProfileRow, error: primaryProfileError } = await input.admin
    .from("workspace_repository_profiles")
    .select("github_repository_id")
    .eq("workspace_id", input.workspaceId)
    .eq("is_primary", true)
    .maybeSingle();

  if (primaryProfileError) {
    throw primaryProfileError;
  }

  const candidateIds = [
    primaryProfileRow?.github_repository_id ?? null,
    input.onboardingRepositoryId,
  ].filter((repositoryId): repositoryId is string => Boolean(repositoryId));

  let configuredRepository: WallieSessionRepository | null = null;

  for (const repositoryId of candidateIds) {
    const repository = await loadSessionRepositoryById({
      admin: input.admin,
      repositoryId,
      workspaceId: input.workspaceId,
    });

    if (!repository) {
      continue;
    }

    configuredRepository ??= repository;

    if (!repository.isArchived) {
      return {
        configuredRepository,
        sessionRepository: repository,
      };
    }
  }

  const fallbackRepository = await loadFirstAvailableSessionRepository(input);

  return {
    configuredRepository: configuredRepository ?? fallbackRepository,
    sessionRepository: fallbackRepository,
  };
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
  const [onboardingResult, firstRunPrereqsResult] = await Promise.all([
    access.context.supabase
      .from("workspace_onboarding")
      .select("status, selected_github_repository_id")
      .eq("workspace_id", normalized.workspaceId)
      .maybeSingle(),
    loadSessionFirstRunPrerequisites({ admin, workspaceId: normalized.workspaceId }).then(
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
  let repositoryForPreflight: WallieSessionRepository | null = null;
  try {
    if (normalized.githubRepositoryId) {
      const repository = await loadSessionRepositoryById({
        admin,
        repositoryId: normalized.githubRepositoryId,
        requireActive: true,
        workspaceId: normalized.workspaceId,
      });

      if (!repository) {
        return NextResponse.json(
          { error: "Repository is not available for this workspace." },
          { status: 400 },
        );
      }

      githubRepositoryId = repository.id;
      repositoryForPreflight = repository;
    } else {
      const { configuredRepository, sessionRepository } = await loadDefaultSessionRepository({
        admin,
        onboardingRepositoryId: onboardingRow.selected_github_repository_id,
        workspaceId: normalized.workspaceId,
      });

      githubRepositoryId = sessionRepository?.id ?? null;
      // Prefer the session pin when active; otherwise keep the configured
      // (possibly archived) candidate so first-run preflight can block create.
      repositoryForPreflight = sessionRepository ?? configuredRepository;
    }
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error, "Wallie could not resolve a session repository.") },
      { status: 500 },
    );
  }

  let agentConfig;
  try {
    if (firstRunPrereqsResult.error || !firstRunPrereqsResult.data) {
      throw firstRunPrereqsResult.error ?? new Error("Wallie is not ready to run.");
    }

    agentConfig = assertSessionFirstRunReady({
      ...firstRunPrereqsResult.data,
      repository: repositoryForPreflight,
    });
    await assertSessionSandboxCapabilityReady({
      admin,
      agentConfig,
      repository: repositoryForPreflight,
      sandboxConnection: firstRunPrereqsResult.data.vercelSandboxConnection,
      workspaceId: normalized.workspaceId,
    });
  } catch (error) {
    try {
      const response = buildAgentRunActionErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status });
    } catch {
      return NextResponse.json(
        { error: getErrorMessage(error, "Wallie is not ready to run.") },
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
      modelName: agentConfig.model,
      modelProvider: agentConfig.provider,
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
