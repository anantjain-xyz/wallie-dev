import type { Enums } from "@/lib/supabase/database.types";

export type PipelinePhaseStatus = Enums<"pipeline_phase_status">;

/**
 * Queue and run status enums. `started` is a legal value on both enums but has
 * no writers anywhere in production code (jobs go `queued -> running` via
 * `claim_next_agent_job`; runs go `queued -> running` via `startAgentRun`). It
 * stays in the enum because Postgres cannot drop an enum value, and it stays in
 * the active sets so a legacy row can never slip past an active-status guard.
 */
export type AgentJobStatus = Enums<"agent_job_status">;
export type AgentRunStatus = Enums<"agent_run_status">;
