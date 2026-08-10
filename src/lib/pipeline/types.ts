import type { Enums } from "@/lib/supabase/database.types";

export type PipelinePhaseStatus = Enums<"pipeline_phase_status">;

export const PIPELINE_JOB_TYPE = "session" as const;
