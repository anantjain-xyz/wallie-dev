import type { Enums } from "@/lib/supabase/database.types";

export type PipelinePhaseStatus = Enums<"pipeline_phase_status">;

export const PIPELINE_JOB_TYPE = "pipeline" as const;
export const PIPELINE_MODEL_NAME = "claude-sonnet-4-20250514" as const;
export const PIPELINE_ESCALATION_THRESHOLD = 3;

export interface ProductSpec {
  title: string;
  problem_statement: string;
  user_story: string;
  acceptance_criteria: string[];
  constraints: string[];
  non_goals: string[];
  open_questions: string[];
}

export interface PreScreenResult {
  pass: boolean;
  reason: string;
}

export interface SlackMentionContext {
  teamId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userId: string;
  text: string;
  linearUrl: string | null;
}

export function buildPipelineDedupeKey(linearIssueId: string): string {
  return `pipeline:${linearIssueId}:active`;
}
