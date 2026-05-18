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

  const { data: onboardingRow, error: onboardingError } = await supabase
    .from("workspace_onboarding")
    .select("status")
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (onboardingError) {
    throw onboardingError;
  }
  if (onboardingRow?.status !== "completed") {
    throw new Error("Complete workspace setup before starting a session.");
  }

  const { data: number, error: numberError } = await supabase.rpc("next_session_number", {
    target_workspace_id: input.workspaceId,
  });

  if (numberError) {
    throw numberError;
  }

  const linearUrl = input.linearIssueUrl?.trim() || null;
  const linearIssueId = linearUrl ? extractLinearIssueId(linearUrl) : null;

  // Look up the workspace's default pipeline + its first stage. New sessions
  // always pin to the default; switching pipelines for a session isn't a v1
  // feature.
  const { data: pipelineRow, error: pipelineError } = await supabase
    .from("pipelines")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("is_default", true)
    .maybeSingle();
  if (pipelineError) throw pipelineError;
  if (!pipelineRow) {
    throw new Error("Workspace has no default pipeline configured.");
  }

  const { data: firstStageRow, error: stageError } = await supabase
    .from("pipeline_stages")
    .select("id")
    .eq("pipeline_id", pipelineRow.id)
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (stageError) throw stageError;
  if (!firstStageRow) {
    throw new Error("Default pipeline has no stages configured.");
  }

  const { error: sessionError } = await supabase.from("sessions").insert({
    current_stage_id: firstStageRow.id,
    linear_issue_id: linearIssueId,
    linear_issue_url: linearUrl,
    number,
    phase_status: "agent_generating",
    pipeline_id: pipelineRow.id,
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
