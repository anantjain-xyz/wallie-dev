import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables } from "@/lib/supabase/database.types";
import { createIssueWithAllocatedNumber } from "@/features/issues/client";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";

// Flow B "New session" creator. Writes an anchor `issues` row (needed for
// agent_jobs.issue_id + wallie panel) and a `sessions` row linked via
// sessions.issue_id. Sessions is the source of truth for phase / status /
// artifacts; the anchor issue stays until PR 4 cleanup migrates the job
// queue + wallie panel onto sessions directly.
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

  const issue = await createIssueWithAllocatedNumber(supabase, {
    descriptionMd: trimmedPrompt,
    title,
    workspaceId: input.workspaceId,
  });

  const linearUrl = input.linearIssueUrl?.trim() || null;
  const linearIssueId = linearUrl ? extractLinearIssueId(linearUrl) : null;

  const issueRow = issue as Tables<"issues">;

  const { error: sessionError } = await supabase.from("sessions").insert({
    creator_member_id: issueRow.creator_member_id,
    issue_id: issueRow.id,
    linear_issue_id: linearIssueId,
    linear_issue_url: linearUrl,
    number: issueRow.number,
    phase: "product",
    phase_status: "agent_generating",
    prompt_md: trimmedPrompt,
    title,
    workspace_id: input.workspaceId,
  });

  if (sessionError) {
    // Roll back the anchor issue so a retry can run cleanly instead of
    // leaving a ghost issue without a session.
    await supabase.from("issues").delete().eq("id", issueRow.id);
    throw sessionError;
  }

  return { number: issueRow.number };
}

function extractLinearIssueId(url: string): string | null {
  const match = url.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)/i);
  if (!match) {
    return null;
  }
  return match[1]!.toUpperCase();
}
