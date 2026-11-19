import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type CreateSessionPayload,
  normalizeCreateSessionPayload,
} from "@/features/sessions/create";
import type { WallieSessionRepository } from "@/features/wallie/types";
import { factoryWritableRepositoryIds } from "@/lib/factory-definitions/repository-bindings";
import { loadActiveFactoryExecution } from "@/lib/factory-definitions/runtime-definition";
import { selectDefaultFactory } from "@/lib/factory-definitions/storage";
import { fetchLinearIssue, type LinearIssue } from "@/lib/linear/client";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { generateSessionTitle } from "@/lib/sessions/generate-title";
import { fingerprintSessionCreation } from "@/lib/sessions/creation-request";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import {
  assertSessionFactoryCredentialReady,
  assertSessionFirstRunReady,
  assertSessionSandboxCapabilityReady,
  createSessionWithFirstJob,
  type CreateSessionWithFirstJobResult,
  findSessionCreationRequest,
  loadSessionFirstRunPrerequisites,
  WallieActionError,
} from "@/lib/wallie/service";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

type SessionCreationFailureKind =
  | "conflict"
  | "failed"
  | "forbidden"
  | "invalid_input"
  | "not_found"
  | "unready";

type SessionCreationErrorCode =
  | "factory_access_denied"
  | "factory_archived"
  | "session_attachments_changed"
  | "session_options_changed"
  | "session_request_conflict";

type SessionCreationFailure =
  | { kind: SessionCreationFailureKind; message: string; code?: SessionCreationErrorCode }
  | { kind: "wallie_action"; cause: WallieActionError };

type SessionCreationCommandResult =
  | { ok: true; session: CreateSessionWithFirstJobResult }
  | { ok: false; failure: SessionCreationFailure };

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

function creationFailure(
  kind: SessionCreationFailureKind,
  message: string,
  code?: SessionCreationErrorCode,
): SessionCreationCommandResult {
  return { ok: false, failure: { kind, message, code } };
}

function sessionOptionsChanged() {
  return creationFailure(
    "conflict",
    "Session options changed. Refresh the repository and stages, then try again.",
    "session_options_changed",
  );
}

function factoryAccessDenied() {
  return creationFailure(
    "forbidden",
    "You cannot start a session with the selected factory resources.",
    "factory_access_denied",
  );
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
  factoryId?: string;
  repositoryId: string;
  requireActive?: boolean;
  workspaceId: string;
}): Promise<WallieSessionRepository | null> {
  const repositories = input.admin.from("github_repositories");
  let query = (
    input.factoryId
      ? repositories.select(`${repositoryPreflightSelect}, github_installations!inner(id)`)
      : repositories.select(repositoryPreflightSelect)
  )
    .eq("id", input.repositoryId)
    .eq("workspace_id", input.workspaceId);

  if (input.requireActive) {
    query = query.eq("is_archived", false);
  }
  if (input.factoryId) {
    query = query
      .eq("factory_id", input.factoryId)
      .eq("github_installations.workspace_id", input.workspaceId)
      .eq("github_installations.suspended", false);
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

async function loadWorkspaceLinearIssue(input: {
  admin: AdminClient;
  issueIdentifier: string;
  workspaceId: string;
}): Promise<LinearIssue> {
  const { data, error } = await input.admin
    .from("workspace_secrets")
    .select("encrypted_value")
    .eq("workspace_id", input.workspaceId)
    .eq("key", "LINEAR_API_KEY")
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Connect Linear before linking an issue to a session.");
  }

  return fetchLinearIssue(decryptSecretValue(data.encrypted_value), input.issueIdentifier);
}

/**
 * The caller supplies an authenticated member and a reader authorized for their restart source.
 * The optional factory fences admission to the intended workspace default.
 */
export async function createSessionCommand({
  actor,
  payload,
  reader,
}: {
  actor: { factoryId?: string; memberId: string; workspaceId: string };
  payload: Omit<CreateSessionPayload, "workspaceId">;
  reader: Pick<SupabaseClient<Database>, "from">;
}): Promise<SessionCreationCommandResult> {
  const intent = { ...payload, workspaceId: actor.workspaceId };
  const normalized = normalizeCreateSessionPayload(intent);
  if (actor.factoryId && !normalized.requestId) {
    return creationFailure(
      "invalid_input",
      "A creation request id is required to start a factory session.",
    );
  }
  const admin = createSupabaseAdminClient();
  const creationRequest = normalized.requestId
    ? { id: normalized.requestId, fingerprint: fingerprintSessionCreation(intent) }
    : undefined;
  if (creationRequest) {
    try {
      const existing = await findSessionCreationRequest({
        admin,
        commandFactoryId: actor.factoryId ?? null,
        creationRequest,
        creatorMemberId: actor.memberId,
        ...(normalized.restartOfSessionId
          ? { restartOfSessionId: normalized.restartOfSessionId }
          : {}),
        workspaceId: actor.workspaceId,
      });
      if (existing) {
        return { ok: true, session: existing };
      }
    } catch (error) {
      return creationRequestFailure(error);
    }
  }
  let pinned: Awaited<ReturnType<typeof loadActiveFactoryExecution>>;
  try {
    pinned = await loadActiveFactoryExecution(admin, actor.workspaceId);
    if (actor.factoryId) {
      let defaultFactoryId = pinned?.factoryId;
      if (!defaultFactoryId) {
        const { data, error } = await selectDefaultFactory(admin, actor.workspaceId);
        if (error) throw error;
        defaultFactoryId = data?.id;
      }
      if (actor.factoryId !== defaultFactoryId) {
        return creationFailure(
          "not_found",
          "The selected factory is unavailable for session creation.",
        );
      }
    }
  } catch (error) {
    return creationFailure(
      "failed",
      getErrorMessage(error, "Wallie could not resolve the active factory definition."),
    );
  }
  if (
    normalized.factoryDefinitionDigest &&
    normalized.factoryDefinitionDigest !== pinned?.canonicalDigest
  ) {
    return sessionOptionsChanged();
  }

  let requestedRepositoryId = normalized.githubRepositoryId?.toLowerCase() ?? null;
  if (normalized.restartOfSessionId) {
    let query = reader
      .from("sessions")
      .select("execute_pinned_definition")
      .eq("workspace_id", actor.workspaceId)
      .eq("id", normalized.restartOfSessionId);
    if (actor.factoryId) query = query.eq("factory_id", actor.factoryId);
    const { data: source, error } = await query.maybeSingle();
    if (error) return creationFailure("failed", error.message);
    if (!source) {
      return creationFailure("not_found", "The session to restart was not found.");
    }
    if (pinned && !requestedRepositoryId && source.execute_pinned_definition) {
      const { data: admission, error: admissionError } = await admin
        .from("session_factory_admission_inputs")
        .select("github_repository_id")
        .eq("workspace_id", actor.workspaceId)
        .eq("session_id", normalized.restartOfSessionId)
        .maybeSingle();
      if (admissionError) {
        return creationFailure("failed", admissionError.message);
      }
      if (!admission?.github_repository_id) return sessionOptionsChanged();
      requestedRepositoryId = admission.github_repository_id;
    }
  }
  if (pinned) {
    requestedRepositoryId ??= pinned.repositoryId;
    if (!factoryWritableRepositoryIds(pinned).includes(requestedRepositoryId)) {
      return sessionOptionsChanged();
    }
  }
  const [onboardingResult, firstRunPrereqsResult, linearIssueResult] = await Promise.all([
    reader
      .from("workspace_onboarding")
      .select("status, selected_github_repository_id")
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle(),
    loadSessionFirstRunPrerequisites({
      admin,
      workspaceId: actor.workspaceId,
      ...(pinned ? { pinned } : {}),
    }).then(
      (data) => ({ data, error: null }),
      (error: unknown) => ({ data: null, error }),
    ),
    normalized.linearIssueId
      ? loadWorkspaceLinearIssue({
          admin,
          issueIdentifier: normalized.linearIssueId,
          workspaceId: actor.workspaceId,
        }).then(
          (data) => ({ data, error: null }),
          (error: unknown) => ({ data: null, error }),
        )
      : Promise.resolve({ data: null, error: null }),
  ]);
  const { data: onboardingRow, error: onboardingError } = onboardingResult;
  if (onboardingError) {
    return creationFailure("failed", onboardingError.message);
  }
  if (onboardingRow?.status !== "completed") {
    return creationFailure("conflict", "Complete workspace setup before starting a session.");
  }

  if (linearIssueResult.error) {
    return creationFailure(
      "unready",
      getErrorMessage(linearIssueResult.error, "Wallie could not load that Linear issue."),
    );
  }

  const linearIssue = linearIssueResult.data;

  let githubRepositoryId: string | null = null;
  let repositoryForPreflight: WallieSessionRepository | null = null;
  try {
    if (requestedRepositoryId) {
      const repository = await loadSessionRepositoryById({
        admin,
        ...(pinned ? { factoryId: pinned.factoryId } : {}),
        repositoryId: requestedRepositoryId,
        requireActive: true,
        workspaceId: actor.workspaceId,
      });

      if (!repository) {
        if (pinned) return sessionOptionsChanged();
        return creationFailure("invalid_input", "Repository is not available for this workspace.");
      }

      githubRepositoryId = repository.id;
      repositoryForPreflight = repository;
    } else {
      const { configuredRepository, sessionRepository } = await loadDefaultSessionRepository({
        admin,
        onboardingRepositoryId: onboardingRow.selected_github_repository_id,
        workspaceId: actor.workspaceId,
      });

      githubRepositoryId = sessionRepository?.id ?? null;
      // Prefer the session pin when active; otherwise keep the configured
      // (possibly archived) candidate so first-run preflight can block create.
      repositoryForPreflight = sessionRepository ?? configuredRepository;
    }
  } catch (error) {
    return creationFailure(
      "failed",
      getErrorMessage(error, "Wallie could not resolve a session repository."),
    );
  }

  let agentConfig;
  try {
    if (pinned) {
      await assertSessionFactoryCredentialReady({
        admin,
        creatorMemberId: actor.memberId,
        definition: pinned,
        factoryId: pinned.factoryId,
        workspaceId: actor.workspaceId,
      });
    }
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
      ...(pinned ? { definitionDigest: pinned.canonicalDigest } : {}),
      repository: repositoryForPreflight,
      sandboxConnection: firstRunPrereqsResult.data.vercelSandboxConnection,
      workspaceId: actor.workspaceId,
    });
  } catch (error) {
    if (error instanceof WallieActionError) {
      return { ok: false, failure: { kind: "wallie_action", cause: error } };
    }
    return creationFailure("failed", getErrorMessage(error, "Wallie is not ready to run."));
  }

  try {
    const confirmedRequest = creationRequest ?? {
      id: crypto.randomUUID(),
      fingerprint: fingerprintSessionCreation(intent),
    };
    const title =
      linearIssue?.title ??
      (intent.title?.trim() ||
        (await generateSessionTitle(normalized.promptMd)) ||
        normalized.title);
    const result = await createSessionWithFirstJob({
      admin,
      attachmentIds: normalized.attachmentIds,
      commandFactoryId: actor.factoryId ?? null,
      creationRequest: confirmedRequest,
      creatorMemberId: actor.memberId,
      factoryDefinitionDigest: pinned?.canonicalDigest ?? null,
      githubRepositoryId,
      linearIssueId: linearIssue?.identifier ?? normalized.linearIssueId,
      linearIssueUrl: linearIssue?.url ?? normalized.linearIssueUrl,
      modelName: agentConfig.model,
      modelProvider: agentConfig.provider,
      promptMd: normalized.promptMd || linearIssue?.description.trim() || linearIssue?.title || "",
      ...(normalized.restartOfSessionId
        ? { restartOfSessionId: normalized.restartOfSessionId }
        : {}),
      selectedStageIds: normalized.selectedStageIds,
      title,
      workspaceId: actor.workspaceId,
    });

    return { ok: true, session: result };
  } catch (error) {
    switch (getErrorCode(error)) {
      case "P0011":
        return creationFailure(
          "conflict",
          "Restore the archived factory before starting a session.",
          "factory_archived",
        );
      case "42501":
        return factoryAccessDenied();
      case "P0005":
        return creationRequestFailure(error);
      case "PT404":
        return creationFailure(
          "not_found",
          normalized.restartOfSessionId
            ? "The session to restart was not found."
            : "Session not found.",
        );
      case "PT422":
        return creationFailure(
          "unready",
          getErrorMessage(error, "The pinned factory is not ready to start."),
        );
      case "PT409":
        if (pinned?.executionGrant) {
          return creationFailure(
            "conflict",
            "Factory execution grant access is changing. Retry session creation.",
          );
        }
        return creationFailure("conflict", "Factory access is changing. Retry session creation.");
      case "P0002":
        return creationFailure(
          "conflict",
          getErrorMessage(error, "Workspace pipeline is not configured."),
        );
      case "P0003":
        return sessionOptionsChanged();
      case "P0004":
        return creationFailure(
          "conflict",
          "One or more session images expired or changed. Remove them and upload again.",
          "session_attachments_changed",
        );
    }

    if (error instanceof WallieActionError) {
      return { ok: false, failure: { kind: "wallie_action", cause: error } };
    }
    return creationFailure(
      "failed",
      getErrorMessage(error, "Wallie could not queue the first run."),
    );
  }
}

function creationRequestFailure(error: unknown) {
  switch (getErrorCode(error)) {
    case "42501":
      return factoryAccessDenied();
    case "P0003":
      return sessionOptionsChanged();
    case "P0005":
      return creationFailure(
        "conflict",
        "This request already created a session with different input. Retry the original request to recover it.",
        "session_request_conflict",
      );
    case "PT404":
      return creationFailure("not_found", "Session not found.");
    case "PT409":
      return creationFailure("conflict", "Factory access is changing. Retry session creation.");
    default:
      return creationFailure(
        "failed",
        getErrorMessage(error, "Wallie could not check this creation request. Try again."),
      );
  }
}
