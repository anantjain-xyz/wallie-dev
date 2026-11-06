import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentRunUsage } from "@/lib/agent-runner/types";
import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;

export type SessionExecutionBudget = {
  elapsedMs: number;
  exhaustionCode: string | null;
  maxCostUsd: number | null;
  maxExecutionMs: number | null;
  maxRepairAttempts: number | null;
  maxTotalTokens: number | null;
  policyRevision: number | null;
  remainingExecutionMs: number | null;
  repairAttemptsUsed: number;
  totalCostUsd: number;
  totalTokens: number;
};

export class ExecutionBudgetExhaustedError extends Error {
  constructor(readonly code: string) {
    super(`Session execution budget exhausted: ${code.replaceAll("_", " ")}.`);
    this.name = "ExecutionBudgetExhaustedError";
  }
}

export async function loadSessionExecutionBudget(
  admin: AdminClient,
  sessionId: string,
): Promise<SessionExecutionBudget | null> {
  const { data, error } = await admin.rpc("get_session_execution_budget", {
    p_session_id: sessionId,
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row) return null;
  return {
    elapsedMs: Number(row.elapsed_ms),
    exhaustionCode: row.exhaustion_code,
    maxCostUsd: row.max_cost_usd === null ? null : Number(row.max_cost_usd),
    maxExecutionMs: row.max_execution_ms === null ? null : Number(row.max_execution_ms),
    maxRepairAttempts: row.max_repair_attempts,
    maxTotalTokens: row.max_total_tokens === null ? null : Number(row.max_total_tokens),
    policyRevision: row.policy_revision === null ? null : Number(row.policy_revision),
    remainingExecutionMs:
      row.remaining_execution_ms === null ? null : Number(row.remaining_execution_ms),
    repairAttemptsUsed: row.repair_attempts_used,
    totalCostUsd: Number(row.total_cost_usd),
    totalTokens: Number(row.total_tokens),
  };
}

export async function recordSessionRunUsage(
  admin: AdminClient,
  input: {
    attemptCount: number;
    finalize?: boolean;
    jobId: string;
    runId: string;
    usage?: AgentRunUsage;
  },
): Promise<void> {
  const usage = input.usage;
  const { data, error } = await admin.rpc("record_session_run_usage", {
    p_job_id: input.jobId,
    p_attempt_count: input.attemptCount,
    p_run_id: input.runId,
    ...(usage
      ? {
          p_input_tokens: usage.inputTokens,
          p_output_tokens: usage.outputTokens,
          p_token_provenance: usage.provenance ?? "measured",
          ...(usage.costUsd !== undefined
            ? {
                p_cost_usd: usage.costUsd,
                p_cost_provenance: usage.costProvenance ?? "measured",
              }
            : {}),
          ...(usage.estimationRevision ? { p_estimation_revision: usage.estimationRevision } : {}),
        }
      : {}),
    p_finalize: input.finalize ?? false,
  });
  if (error) throw error;
  const receipt = data?.[0];
  if (!receipt?.accepted) {
    const ownershipError = new Error("This execution no longer owns its run.");
    ownershipError.name = "ExecutionOwnershipLostError";
    throw ownershipError;
  }
  if (receipt.exhaustion_code) {
    throw new ExecutionBudgetExhaustedError(receipt.exhaustion_code);
  }
}

export function remainingTokenBudget(budget: SessionExecutionBudget | null): number | undefined {
  if (!budget || budget.maxTotalTokens === null) return undefined;
  return Math.max(1, Math.floor(budget.maxTotalTokens - budget.totalTokens));
}
