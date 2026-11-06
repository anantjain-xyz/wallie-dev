import { describe, expect, it, vi } from "vitest";

import {
  ExecutionBudgetExhaustedError,
  loadSessionExecutionBudget,
  recordSessionRunUsage,
  remainingTokenBudget,
} from "./execution-budget";

const budgetRow = {
  policy_revision: 7,
  max_repair_attempts: 3,
  max_execution_ms: 60_000,
  max_total_tokens: 1_000,
  max_cost_usd: 2.5,
  repair_attempts_used: 2,
  elapsed_ms: 10_000,
  total_tokens: 250,
  total_cost_usd: 1.25,
  tokens_unavailable: false,
  cost_unavailable: false,
  remaining_execution_ms: 50_000,
  exhaustion_code: null,
};

describe("execution budget accounting contract", () => {
  it("loads versioned limits and computes the remaining adapter ceiling", async () => {
    const admin = {
      rpc: vi.fn(async () => ({ data: [budgetRow], error: null })),
    };
    const budget = await loadSessionExecutionBudget(admin as never, "session-1");

    expect(admin.rpc).toHaveBeenCalledWith("get_session_execution_budget", {
      p_session_id: "session-1",
    });
    expect(budget).toMatchObject({ policyRevision: 7, maxTotalTokens: 1_000, totalTokens: 250 });
    expect(remainingTokenBudget(budget)).toBe(750);
  });

  it("normalizes measured usage and cost with independent provenance", async () => {
    const admin = {
      rpc: vi.fn(async () => ({
        data: [{ accepted: true, exhaustion_code: null }],
        error: null,
      })),
    };

    await recordSessionRunUsage(admin as never, {
      attemptCount: 2,
      finalize: true,
      jobId: "job-1",
      runId: "run-1",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        costUsd: 0.125,
        costProvenance: "estimated",
        estimationRevision: "pricing-2026-11",
      },
    });

    expect(admin.rpc).toHaveBeenCalledWith("record_session_run_usage", {
      p_job_id: "job-1",
      p_attempt_count: 2,
      p_run_id: "run-1",
      p_input_tokens: 10,
      p_output_tokens: 20,
      p_token_provenance: "measured",
      p_cost_usd: 0.125,
      p_cost_provenance: "estimated",
      p_estimation_revision: "pricing-2026-11",
      p_finalize: true,
    });
  });

  it("finalizes missing telemetry as unavailable instead of sending zeroes", async () => {
    const admin = {
      rpc: vi.fn(async () => ({
        data: [{ accepted: true, exhaustion_code: null }],
        error: null,
      })),
    };

    await recordSessionRunUsage(admin as never, {
      attemptCount: 1,
      finalize: true,
      jobId: "job-1",
      runId: "run-1",
    });

    expect(admin.rpc).toHaveBeenCalledWith("record_session_run_usage", {
      p_job_id: "job-1",
      p_attempt_count: 1,
      p_run_id: "run-1",
      p_finalize: true,
    });
  });

  it("raises a terminal budget error after the durable receipt", async () => {
    const admin = {
      rpc: vi.fn(async () => ({
        data: [{ accepted: true, exhaustion_code: "tokens" }],
        error: null,
      })),
    };

    await expect(
      recordSessionRunUsage(admin as never, {
        attemptCount: 1,
        jobId: "job-1",
        runId: "run-1",
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
    ).rejects.toEqual(new ExecutionBudgetExhaustedError("tokens"));
  });
});
