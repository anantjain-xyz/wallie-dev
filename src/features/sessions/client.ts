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
import type { SessionAttachmentUploadResponse } from "@/lib/storage/contracts";

export type CreateSessionInput = {
  attachmentIds?: string[];
  githubRepositoryId?: string | null;
  linearIssueUrl?: string | null;
  promptMd?: string | null;
  selectedStageIds?: string[];
  title?: string | null;
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
  defaultGithubRepositoryId: string | null;
  pipelineId: string | null;
  repositoryOptions: SessionRepositoryOption[];
  stageOptions: SessionCreationStageOption[];
};

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
  workspaceId: string;
}): Promise<SessionRepositoryOptionsResult> {
  const response = await fetch(`/api/workspaces/${input.workspaceId}/session-repositories`, {
    cache: "no-store",
    method: "GET",
  });
  const responsePayload = (await response.json().catch(() => null)) as {
    defaultGithubRepositoryId?: string | null;
    error?: string;
    pipelineId?: string | null;
    repositoryOptions?: SessionRepositoryOption[];
    stageOptions?: SessionCreationStageOption[];
  } | null;

  if (!response.ok) {
    throw new Error(responsePayload?.error ?? "Failed to load session options.");
  }

  if (
    !Array.isArray(responsePayload?.repositoryOptions) ||
    !Array.isArray(responsePayload?.stageOptions)
  ) {
    throw new Error("Session options response was invalid.");
  }

  return {
    defaultGithubRepositoryId: responsePayload.defaultGithubRepositoryId ?? null,
    pipelineId: responsePayload.pipelineId ?? null,
    repositoryOptions: responsePayload.repositoryOptions,
    stageOptions: responsePayload.stageOptions,
  };
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
    githubRepositoryId: input.githubRepositoryId?.trim() || null,
    linearIssueUrl,
    promptMd: trimmedPrompt,
    ...(input.selectedStageIds ? { selectedStageIds: input.selectedStageIds } : {}),
    title: input.title?.trim() || null,
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
    canonicalUrl?: string;
    number?: number;
  } | null;

  if (!response.ok) {
    if (responsePayload?.code === "session_options_changed") {
      throw new SessionOptionsChangedError(
        responsePayload.error ?? "The workspace pipeline changed. Refresh and try again.",
      );
    }
    throw new Error(responsePayload?.error ?? "Failed to create session.");
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
