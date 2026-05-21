import type { SupabaseClient } from "@supabase/supabase-js";

import { createSessionPayloadSchema } from "@/features/sessions/create";
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
