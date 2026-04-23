import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";

export type CreateSessionInput = {
  linearIssueUrl?: string | null;
  promptMd: string;
  title?: string | null;
  workspaceId: string;
};

export type CreateSessionResult = {
  number: number;
};

export async function createSessionFromClient(
  supabase: SupabaseClient<Database>,
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const trimmedPrompt = input.promptMd.trim();
  if (trimmedPrompt.length === 0) {
    throw new Error("Prompt is required.");
  }

  const title = input.title?.trim() || deriveSessionTitleFromPrompt(trimmedPrompt);

  const { data: number, error: numberError } = await supabase.rpc("next_session_number", {
    target_workspace_id: input.workspaceId,
  });

  if (numberError) {
    throw numberError;
  }

  const linearUrl = input.linearIssueUrl?.trim() || null;
  const linearIssueId = linearUrl ? extractLinearIssueId(linearUrl) : null;

  const { error: sessionError } = await supabase.from("sessions").insert({
    linear_issue_id: linearIssueId,
    linear_issue_url: linearUrl,
    number,
    phase: "product",
    phase_status: "agent_generating",
    prompt_md: trimmedPrompt,
    title,
    workspace_id: input.workspaceId,
  });

  if (sessionError) {
    throw sessionError;
  }

  return { number };
}

function extractLinearIssueId(url: string): string | null {
  const match = url.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)/i);
  if (!match) {
    return null;
  }
  return match[1]!.toUpperCase();
}
