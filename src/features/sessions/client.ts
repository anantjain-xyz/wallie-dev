import type {
  SessionMutationStage,
  SessionPhaseMutationResult,
  SessionTitleMutationResult,
} from "@/features/sessions/mutation-contracts";
import { updateSessionTitleClientInputSchema } from "@/features/sessions/update-title";
import type {
  SessionCreationStageOption,
  SessionRepositoryOption,
} from "@/features/sessions/types";
import type { WorkflowIntakeSelection } from "@/lib/factory-workflows/intake-selection";
import {
  routingOverrideOptionsSchema,
  type RoutingOverride,
  type RoutingOverrideOptions,
} from "@/lib/model-routing/operation-contracts";
import type { SessionAttachmentUploadResponse } from "@/lib/storage/contracts";

export type CreateSessionInput = {
  attachmentIds?: string[];
  draftSpecification?: boolean;
  factoryDefinitionDigest?: string;
  factoryId?: string;
  githubRepositoryId?: string | null;
  linearIssueUrl?: string | null;
  promptMd?: string | null;
  requestId?: string;
  routingOverride?: RoutingOverride;
  selectedStageIds?: string[];
  title?: string | null;
  workflowSelection?: WorkflowIntakeSelection;
  workspaceId: string;
};

export type CreateSessionResult = {
  canonicalUrl: string;
  number: number;
};

export class SessionOptionsChangedError extends Error {
  readonly code = "session_options_changed";

  constructor(message: string) {
    super(message);
    this.name = "SessionOptionsChangedError";
  }
}

export class SessionAttachmentsChangedError extends Error {
  readonly code = "session_attachments_changed";

  constructor(message: string) {
    super(message);
    this.name = "SessionAttachmentsChangedError";
  }
}

export type UpdateSessionTitleInput = {
  sessionId: string;
  title: string;
};

export type UpdateSessionTitleResult = SessionTitleMutationResult;

export type SessionArchiveResult = {
  archivedAt: string | null;
  id: string;
  phaseStatus: "in_progress" | "approved" | "awaiting_review" | "rejected";
  updatedAt: string;
};

export type SessionRepositoryOptionsResult = {
  canDraftSpecification?: boolean;
  defaultGithubRepositoryId: string | null;
  factoryDefinitionDigest?: string;
  factoryId?: string;
  linearIssueLinking?: boolean;
  pipelineId: string | null;
  repositoryOptions: SessionRepositoryOption[];
  routingOverrideOptions?: RoutingOverrideOptions;
  stageOptions: SessionCreationStageOption[];
};

export type SessionCreationFactory = { id: string; name: string };

export async function loadSessionCreationFactoriesFromClient(input: {
  signal: AbortSignal;
  workspaceId: string;
}): Promise<SessionCreationFactory[]> {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/session-factories`,
    { cache: "no-store", signal: input.signal },
  );
  const payload = (await response.json().catch(() => null)) as {
    factories?: SessionCreationFactory[];
    error?: string;
  } | null;
  if (!response.ok) throw new Error(payload?.error ?? "Couldn’t load factories.");
  if (
    !Array.isArray(payload?.factories) ||
    payload.factories.some(
      (factory) => typeof factory?.id !== "string" || typeof factory.name !== "string",
    )
  ) {
    throw new Error("The factory list response was invalid.");
  }
  return payload.factories;
}

export async function uploadSessionAttachmentFromClient(input: {
  file: File;
  workspaceId: string;
}): Promise<SessionAttachmentUploadResponse> {
  const formData = new FormData();
  formData.append("file", input.file);

  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/session-attachments`,
    { body: formData, method: "POST" },
  );
  const payload = (await response.json().catch(() => null)) as
    | (Partial<SessionAttachmentUploadResponse> & { error?: string })
    | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to upload session image.");
  }

  if (
    typeof payload?.id !== "string" ||
    typeof payload.fileName !== "string" ||
    typeof payload.contentType !== "string" ||
    typeof payload.sizeBytes !== "number"
  ) {
    throw new Error("Session image response was invalid.");
  }

  return payload as SessionAttachmentUploadResponse;
}

export async function deletePendingSessionAttachmentFromClient(input: {
  attachmentId: string;
  workspaceId: string;
}) {
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(input.workspaceId)}/session-attachments/${encodeURIComponent(input.attachmentId)}`,
    { method: "DELETE" },
  );

  if (response.ok || response.status === 404) return;

  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(payload?.error ?? "Failed to remove session image.");
}

export async function loadSessionStateFromClient(input: {
  sessionId: string;
}): Promise<SessionPhaseMutationResult> {
  const response = await fetch(`/api/sessions/${input.sessionId}/state`, { method: "GET" });
  const payload = (await response.json().catch(() => null)) as
    | (Partial<SessionPhaseMutationResult> & { error?: string })
    | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? "Failed to reconcile the session stage.");
  }

  if (!isSessionPhaseMutationResult(payload)) {
    throw new Error("Session state response was invalid.");
  }

  return payload;
}

export function isSessionPhaseMutationResult(
  payload: Partial<SessionPhaseMutationResult> | null,
): payload is SessionPhaseMutationResult {
  const stage = payload?.currentStage as Partial<SessionMutationStage> | undefined;

  return Boolean(
    payload &&
    typeof payload.archivedAt !== "undefined" &&
    typeof payload.artifactVersion === "number" &&
    typeof payload.currentStageId === "string" &&
    stage &&
    typeof stage.description === "string" &&
    typeof stage.id === "string" &&
    typeof stage.name === "string" &&
    typeof stage.position === "number" &&
    typeof stage.slug === "string" &&
    stage.id === payload.currentStageId &&
    typeof payload.id === "string" &&
    typeof payload.phaseStatus === "string" &&
    typeof payload.rejectionCount === "number" &&
    typeof payload.updatedAt === "string",
  );
}

export async function loadSessionRepositoryOptionsFromClient(input: {
  factoryId?: string;
  workspaceId: string;
}): Promise<SessionRepositoryOptionsResult> {
  const query = input.factoryId ? `?${new URLSearchParams({ factoryId: input.factoryId })}` : "";
  const response = await fetch(
    `/api/workspaces/${input.workspaceId}/session-repositories${query}`,
    {
      cache: "no-store",
      method: "GET",
    },
  );
  const responsePayload = (await response.json().catch(() => null)) as {
    canDraftSpecification?: boolean;
    defaultGithubRepositoryId?: string | null;
    error?: string;
    factoryDefinitionDigest?: string;
    factoryId?: string;
    linearIssueLinking?: boolean;
    pipelineId?: string | null;
    repositoryOptions?: SessionRepositoryOption[];
    routingOverrideOptions?: unknown;
    setupHref?: string;
    stageOptions?: SessionCreationStageOption[];
  } | null;

  if (!response.ok) {
    throw new SessionCreationRejectedError(
      responsePayload?.error ?? "Failed to load session options.",
      response.status,
      readSessionSetupHref(responsePayload?.setupHref),
    );
  }

  if (
    !Array.isArray(responsePayload?.repositoryOptions) ||
    !Array.isArray(responsePayload?.stageOptions) ||
    (input.factoryId !== undefined &&
      (responsePayload.factoryId !== input.factoryId ||
        typeof responsePayload.linearIssueLinking !== "boolean")) ||
    (responsePayload.factoryDefinitionDigest !== undefined &&
      (typeof responsePayload.factoryDefinitionDigest !== "string" ||
        !/^[0-9a-f]{64}$/.test(responsePayload.factoryDefinitionDigest)))
  ) {
    throw new Error("Session options response was invalid.");
  }

  const { factoryDefinitionDigest } = responsePayload;
  const overrideOptions = routingOverrideOptionsSchema
    .optional()
    .safeParse(responsePayload.routingOverrideOptions);
  if (!overrideOptions.success) throw new Error("Session routing options response was invalid.");
  return {
    ...(responsePayload.canDraftSpecification === true ? { canDraftSpecification: true } : {}),
    defaultGithubRepositoryId: responsePayload.defaultGithubRepositoryId ?? null,
    ...(factoryDefinitionDigest ? { factoryDefinitionDigest } : {}),
    ...(input.factoryId
      ? {
          factoryId: responsePayload.factoryId,
          linearIssueLinking: responsePayload.linearIssueLinking,
        }
      : {}),
    pipelineId: responsePayload.pipelineId ?? null,
    repositoryOptions: responsePayload.repositoryOptions,
    ...(factoryDefinitionDigest && overrideOptions.data
      ? { routingOverrideOptions: overrideOptions.data }
      : {}),
    stageOptions: responsePayload.stageOptions,
  };
}

export class SessionCreationRejectedError extends Error {
  readonly creationRejected = true;

  constructor(
    message: string,
    readonly status?: number,
    readonly setupHref?: string,
  ) {
    super(message);
  }
}

function readSessionSetupHref(value: unknown) {
  return typeof value === "string" && /^\/w\/[a-z0-9][a-z0-9-]*\//.test(value) ? value : undefined;
}

export async function createSessionFromClient(
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const linearIssueUrl = input.linearIssueUrl?.trim() || null;
  const trimmedPrompt = input.promptMd?.trim() ?? "";
  if (!linearIssueUrl && trimmedPrompt.length === 0) {
    throw new Error("Enter a Linear issue URL or a prompt.");
  }

  const payload = {
    ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
    ...(input.draftSpecification ? { draftSpecification: true } : {}),
    ...(input.factoryDefinitionDigest
      ? { factoryDefinitionDigest: input.factoryDefinitionDigest }
      : {}),
    ...(input.factoryId ? { factoryId: input.factoryId } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    githubRepositoryId: input.githubRepositoryId?.trim() || null,
    linearIssueUrl,
    promptMd: trimmedPrompt,
    ...(input.routingOverride ? { routingOverride: input.routingOverride } : {}),
    ...(input.selectedStageIds ? { selectedStageIds: input.selectedStageIds } : {}),
    title: input.title?.trim() || null,
    ...(input.workflowSelection ? { workflowSelection: input.workflowSelection } : {}),
    workspaceId: input.workspaceId,
  };

  const response = await fetch("/api/sessions", {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const responsePayload = (await response.json().catch(() => null)) as {
    code?: string;
    error?: string;
    setupHref?: string;
    canonicalUrl?: string;
    number?: number;
  } | null;

  if (!response.ok) {
    if (responsePayload?.code === "session_attachments_changed") {
      throw new SessionAttachmentsChangedError(
        responsePayload.error ?? "Session images changed. Refresh and try again.",
      );
    }
    if (responsePayload?.code === "session_options_changed") {
      throw new SessionOptionsChangedError(
        responsePayload.error ?? "The workspace pipeline changed. Refresh and try again.",
      );
    }
    const message = responsePayload?.error ?? "Failed to create session.";
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      responsePayload?.code !== "session_request_conflict"
    ) {
      throw new SessionCreationRejectedError(
        message,
        response.status,
        readSessionSetupHref(responsePayload?.setupHref),
      );
    }
    throw new Error(message);
  }

  if (
    typeof responsePayload?.number !== "number" ||
    typeof responsePayload.canonicalUrl !== "string"
  ) {
    throw new Error("Session response did not include a session number.");
  }

  return { canonicalUrl: responsePayload.canonicalUrl, number: responsePayload.number };
}

export async function updateSessionTitleFromClient(
  input: UpdateSessionTitleInput,
): Promise<UpdateSessionTitleResult> {
  const parsed = updateSessionTitleClientInputSchema.parse({
    sessionId: input.sessionId,
    title: input.title,
  });

  const response = await fetch(`/api/sessions/${parsed.sessionId}`, {
    body: JSON.stringify({ title: parsed.title }),
    headers: { "content-type": "application/json" },
    method: "PATCH",
  });
  const responsePayload = (await response.json().catch(() => null)) as {
    error?: string;
    id?: string;
    title?: string;
    updatedAt?: string;
  } | null;

  if (!response.ok) {
    throw new Error(responsePayload?.error ?? "Failed to update session title.");
  }

  if (
    typeof responsePayload?.id !== "string" ||
    typeof responsePayload.title !== "string" ||
    typeof responsePayload.updatedAt !== "string"
  ) {
    throw new Error("Session title response was invalid.");
  }

  return {
    id: responsePayload.id,
    title: responsePayload.title,
    updatedAt: responsePayload.updatedAt,
  };
}

async function mutateSessionArchive(
  sessionId: string,
  method: "DELETE" | "POST",
  fallbackError: string,
  expectedArchivedAt?: string,
): Promise<SessionArchiveResult> {
  const response = await fetch(`/api/sessions/${sessionId}/archive`, {
    ...(expectedArchivedAt
      ? {
          body: JSON.stringify({ expectedArchivedAt }),
          headers: { "content-type": "application/json" },
        }
      : {}),
    method,
  });
  const responsePayload = (await response.json().catch(() => null)) as {
    archivedAt?: string | null;
    error?: string;
    id?: string;
    phaseStatus?: SessionArchiveResult["phaseStatus"];
    updatedAt?: string;
  } | null;

  if (!response.ok) {
    throw new Error(responsePayload?.error ?? fallbackError);
  }

  if (
    typeof responsePayload?.id !== "string" ||
    typeof responsePayload.phaseStatus !== "string" ||
    typeof responsePayload.updatedAt !== "string"
  ) {
    throw new Error("Session archive response was invalid.");
  }

  return {
    archivedAt: responsePayload.archivedAt ?? null,
    id: responsePayload.id,
    phaseStatus: responsePayload.phaseStatus,
    updatedAt: responsePayload.updatedAt,
  };
}

export async function archiveSessionFromClient(input: {
  sessionId: string;
}): Promise<SessionArchiveResult> {
  return mutateSessionArchive(input.sessionId, "POST", "Failed to archive session.");
}

export async function unarchiveSessionFromClient(input: {
  expectedArchivedAt?: string;
  sessionId: string;
}): Promise<SessionArchiveResult> {
  return mutateSessionArchive(
    input.sessionId,
    "DELETE",
    "Failed to unarchive session.",
    input.expectedArchivedAt,
  );
}
