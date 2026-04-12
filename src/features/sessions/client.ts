import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Tables, TablesInsert } from "@/lib/supabase/database.types";
import { createIssueWithAllocatedNumber } from "@/features/issues/client";
import { deriveSessionTitleFromPrompt } from "@/features/sessions/types";

// Flow B "New session" creator. Writes a legacy `issues + pipeline_issues`
// pair (which is what the pipeline processor, Slack interactions, and the
// session read paths all consume today) and mirrors the row into `sessions`
// to stay consistent with PR 1's Slack shadow-write. Backend cutover will
// collapse these writes into sessions-only.
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

  const pipelinePayload: TablesInsert<"pipeline_issues"> = {
    issue_id: issue.id,
    linear_issue_id: linearIssueId,
    linear_issue_url: linearUrl,
    phase: "product",
    phase_status: "agent_generating",
    workspace_id: input.workspaceId,
  };

  const { error: pipelineError } = await supabase
    .from("pipeline_issues")
    .insert(pipelinePayload);

  if (pipelineError) {
    throw pipelineError;
  }

  // Shadow-write to `sessions` so Flow B rows appear in the new table
  // alongside the Slack path's shadow-writes (PR 1). Best-effort: failures
  // log and continue, matching the Slack handler. When the backend cutover
  // flips reads to `sessions`, these rows already exist.
  const issueRow = issue as Tables<"issues">;
  const { error: sessionError } = await supabase.from("sessions").insert({
    creator_member_id: issueRow.creator_member_id,
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
    const isDedupe =
      typeof sessionError === "object" &&
      sessionError !== null &&
      "code" in sessionError &&
      (sessionError as { code?: string }).code === "23505";
    if (!isDedupe) {
      console.error("Failed to shadow-write sessions row from createSession", {
        error: sessionError,
      });
    }
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
