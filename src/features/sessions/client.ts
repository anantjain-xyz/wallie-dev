import type { SupabaseClient } from "@supabase/supabase-js";

import { createSessionPayloadSchema } from "@/features/sessions/create";
import { updateSessionTitlePayloadSchema } from "@/features/sessions/update-title";
import type { Database } from "@/lib/supabase/database.types";

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

export type UpdateSessionTitleResult = {
  id: string;
  title: string;
  updatedAt: string;
};

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
  const parsedPayload = updateSessionTitlePayloadSchema.safeParse({
    title: input.title,
  });

  if (!parsedPayload.success) {
    const firstIssue = parsedPayload.error.issues[0];
    throw new Error(firstIssue?.message ?? "Session title is invalid.");
  }

  const payload = parsedPayload.data;

  const response = await fetch(`/api/sessions/${input.sessionId}`, {
    body: JSON.stringify(payload),
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
    throw new Error("Session title response was malformed.");
  }

  return {
    id: responsePayload.id,
    title: responsePayload.title,
    updatedAt: responsePayload.updatedAt,
  };
}
