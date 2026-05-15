import type { Enums } from "@/lib/supabase/database.types";

export type PipelinePhaseStatus = Enums<"pipeline_phase_status">;

export const PIPELINE_JOB_TYPE = "session" as const;
export const PIPELINE_MODEL_NAME = "claude-sonnet-4-20250514" as const;

export function buildPipelineDedupeKey(linearIssueId: string): string {
  return `pipeline:${linearIssueId}:active`;
}
