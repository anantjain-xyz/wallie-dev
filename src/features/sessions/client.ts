import type { SupabaseClient } from "@supabase/supabase-js";

import { createSessionPayloadSchema } from "@/features/sessions/create";
import type { SessionTitleMutationResult } from "@/features/sessions/mutation-contracts";
import { updateSessionTitleClientInputSchema } from "@/features/sessions/update-title";
import type { Database } from "@/lib/supabase/database.types";
import type { SessionRepositoryOption } from "@/features/sessions/types";

export type CreateSessionInput = {
  githubRepositoryId?: string | null;
  linearIssueUrl?: string | null;
  promptMd: string;
  title?: string | null;
  workspaceId: string;
};

export type CreateSessionResult = {
  number: number;
};

export type UpdateSessionTitleInput = {
  sessionId: string;
  title: string;
};

export type UpdateSessionTitleResult = SessionTitleMutationResult;

export type SessionArchiveResult = {
  archivedAt: string | null;
  id: string;
};

export type SessionRepositoryOptionsResult = {
  defaultGithubRepositoryId: string | null;
  repositoryOptions: SessionRepositoryOption[];
};

export async function loadSessionRepositoryOptionsFromClient(input: {
  workspaceId: string;
}): Promise<SessionRepositoryOptionsResult> {
  const response = await fetch(`/api/workspaces/${input.workspaceId}/session-repositories`, {
    method: "GET",
  });
  const responsePayload = (await response.json().catch(() => null)) as {
    defaultGithubRepositoryId?: string | null;
    error?: string;
    repositoryOptions?: SessionRepositoryOption[];
  } | null;

  if (!response.ok) {
    throw new Error(responsePayload?.error ?? "Failed to load repositories.");
  }

  if (!Array.isArray(responsePayload?.repositoryOptions)) {
    throw new Error("Repository response was invalid.");
  }

  return {
    defaultGithubRepositoryId: responsePayload.defaultGithubRepositoryId ?? null,
    repositoryOptions: responsePayload.repositoryOptions,
  };
}

export async function createSessionFromClient(
  _supabase: SupabaseClient<Database>,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const trimmedPrompt = input.promptMd.trim();
  if (trimmedPrompt.length === 0) {
    throw new Error("Prompt is required.");
  }

  const payload = createSessionPayloadSchema.parse({
    githubRepositoryId: input.githubRepositoryId?.trim() || null,
    linearIssueUrl: input.linearIssueUrl?.trim() || null,
    promptMd: trimmedPrompt,
    title: input.title?.trim() || null,
    workspaceId: input.workspaceId,
  });

  const response = await fetch("/api/sessions", {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const responsePayload = (await response.json().catch(() => null)) as {
    error?: string;
    number?: number;
  } | null;

  if (!response.ok) {
    throw new Error(responsePayload?.error ?? "Failed to create session.");
  }

  if (typeof responsePayload?.number !== "number") {
    throw new Error("Session response did not include a session number.");
  }

  return { number: responsePayload.number };
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
): Promise<SessionArchiveResult> {
  const response = await fetch(`/api/sessions/${sessionId}/archive`, { method });
  const responsePayload = (await response.json().catch(() => null)) as {
    archivedAt?: string | null;
    error?: string;
    id?: string;
  } | null;

  if (!response.ok) {
    throw new Error(responsePayload?.error ?? fallbackError);
  }

  if (typeof responsePayload?.id !== "string") {
    throw new Error("Session archive response was invalid.");
  }

  return {
    archivedAt: responsePayload.archivedAt ?? null,
    id: responsePayload.id,
  };
}

export async function archiveSessionFromClient(input: {
  sessionId: string;
}): Promise<SessionArchiveResult> {
  return mutateSessionArchive(input.sessionId, "POST", "Failed to archive session.");
}

export async function unarchiveSessionFromClient(input: {
  sessionId: string;
}): Promise<SessionArchiveResult> {
  return mutateSessionArchive(input.sessionId, "DELETE", "Failed to unarchive session.");
}
