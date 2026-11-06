import type { Enums, Tables } from "@/lib/supabase/database.types";

/** Fixed at enqueue when lineage is known; its first execution binds once, and retries reuse it. */
export type PinnedGitInput = Tables<"session_job_git_inputs">;

/** Accepted artifact provenance; an absent row means historical/unknown code. */
export type GitCheckpoint = Tables<"session_git_checkpoints">;

/** Delivery configuration is versioned independently of artifact approval. */
export type DeliveryPolicyRevision = Tables<"delivery_policy_revisions">;
export type PrVerificationObservation = Tables<"session_pr_verification_observations">;
export type PrVerificationResult = Tables<"session_pr_verification_results">;
export type PrReadinessStatus = Enums<"pr_readiness_state">;

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
