import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import { QUALIFIED_BENCHMARK_RUNNER } from "./qualified-trial-contracts";
import { RECORDED_FIXTURE_RUNNER, replayDigestSchema } from "./replay-contracts";

const maxTrials = 10_000;
const runnerRevision = z.enum([RECORDED_FIXTURE_RUNNER, QUALIFIED_BENCHMARK_RUNNER]);
const scheduleUsd = z.number().min(0).max(1_000_000).multipleOf(0.000001);
const factoryConcurrencyLimit = z.number().int().min(1).max(100);
const maxAdmittedTrials = z.number().int().min(1).max(maxTrials);
const trialCount = z.number().int().min(0).max(maxTrials);
export const benchmarkScheduleIdSchema = z.string().uuid().toLowerCase();

const scheduleLimits = {
  action: z.literal("configure"),
  executionReserveUsd: scheduleUsd,
  evaluationReserveUsd: scheduleUsd,
  budgetLimitUsd: scheduleUsd,
  factoryConcurrencyLimit,
  maxAdmittedTrials,
};

const configureFixtureSchedule = z.strictObject({
  ...scheduleLimits,
  runnerRevision: z.literal(RECORDED_FIXTURE_RUNNER),
  sandboxConnectionRevision: benchmarkScheduleIdSchema,
  taskFixtures: z
    .array(
      z.strictObject({
        taskRevisionId: benchmarkScheduleIdSchema,
        fixtureKey: replayDigestSchema,
      }),
    )
    .min(1)
    .max(maxTrials)
    .refine(
      (fixtures) =>
        new Set(fixtures.map((fixture) => fixture.taskRevisionId)).size === fixtures.length,
    ),
});

const configureLiveSchedule = z.strictObject({
  ...scheduleLimits,
  executionReserveUsd: scheduleUsd.positive(),
  runnerRevision: z.literal(QUALIFIED_BENCHMARK_RUNNER),
  inferenceConnectionRevision: benchmarkScheduleIdSchema,
});

export const benchmarkScheduleCommandSchema = z
  .union([
    z.discriminatedUnion("runnerRevision", [configureFixtureSchedule, configureLiveSchedule]),
    z.strictObject({ action: z.literal("pause") }),
    z.strictObject({ action: z.literal("resume") }),
    z.strictObject({ action: z.literal("cancel") }),
  ])
  .refine(
    (command) =>
      command.action !== "configure" || command.executionReserveUsd <= command.budgetLimitUsd,
  );

const scheduleSnapshotSchema = z
  .object({
    experimentId: benchmarkScheduleIdSchema,
    state: z.enum(["active", "paused", "canceled"]),
    runnerRevision,
    sandboxConnectionRevision: benchmarkScheduleIdSchema,
    budgetLimitUsd: scheduleUsd,
    executionReserveUsd: scheduleUsd,
    evaluationReserveUsd: scheduleUsd,
    factoryConcurrencyLimit,
    maxAdmittedTrials,
    plannedTrialCount: trialCount,
    eligibleTrialCount: trialCount,
    admittedTrialCount: trialCount,
    queuedTrialCount: trialCount,
    runningTrialCount: trialCount,
    terminalTrialCount: trialCount,
    executionSpentUsd: z.number().nonnegative(),
    evaluationSpentUsd: z.number().nonnegative(),
    reservedUsd: z.number().nonnegative(),
    unavailableExecutionCount: trialCount,
    unavailableEvaluationCount: z.number().int().nonnegative(),
    admissionIssue: z.enum(["pinned-input-unavailable", "trial-identity-conflict"]).nullable(),
  })
  .refine(
    (snapshot) =>
      snapshot.admittedTrialCount <= snapshot.eligibleTrialCount &&
      snapshot.eligibleTrialCount <= snapshot.plannedTrialCount &&
      snapshot.queuedTrialCount + snapshot.runningTrialCount + snapshot.terminalTrialCount ===
        snapshot.admittedTrialCount,
  );

type ScheduleCommand = z.infer<typeof benchmarkScheduleCommandSchema>;
type ScheduleScope = {
  admin: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
  experimentId: string;
  actorUserId: string;
  signal: AbortSignal;
};

export class BenchmarkScheduleError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 412 | 422,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkScheduleError";
  }
}

function scheduleRpcError(code: string) {
  switch (code) {
    case "42501":
      return new BenchmarkScheduleError(403, "Factory manager access is required.");
    case "P0002":
    case "PT404":
      return new BenchmarkScheduleError(
        404,
        "The benchmark experiment or schedule is unavailable.",
      );
    case "P0011":
    case "PT409":
      return new BenchmarkScheduleError(409, "The benchmark schedule cannot make this change.");
    case "PT412":
      return new BenchmarkScheduleError(
        412,
        "This comparison requires a runner that uses its pinned configurations.",
      );
    case "22023":
    case "23514":
    case "PT422":
      return new BenchmarkScheduleError(
        422,
        "Review the runner, fixture, connection and budget selections.",
      );
    default:
      return new Error("The benchmark schedule request failed.");
  }
}

export async function requestBenchmarkSchedule(
  { admin, workspaceId, factoryId, experimentId, actorUserId, signal }: ScheduleScope,
  command: ScheduleCommand | { action: "read" },
) {
  const scope = {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_experiment_id: experimentId,
    p_actor_user_id: actorUserId,
  };
  let request;
  switch (command.action) {
    case "read":
      request = admin.rpc("read_factory_benchmark_schedule", scope);
      break;
    case "configure": {
      const limits = {
        p_execution_reserve_usd: command.executionReserveUsd,
        p_evaluation_reserve_usd: command.evaluationReserveUsd,
        p_budget_limit_usd: command.budgetLimitUsd,
        p_factory_concurrency_limit: command.factoryConcurrencyLimit,
        p_max_admitted_trials: command.maxAdmittedTrials,
      };
      request =
        command.runnerRevision === QUALIFIED_BENCHMARK_RUNNER
          ? admin.rpc("configure_factory_benchmark_live_schedule", {
              ...scope,
              p_inference_connection_revision: command.inferenceConnectionRevision,
              ...limits,
            })
          : admin.rpc("configure_factory_benchmark_schedule", {
              ...scope,
              p_runner_revision: command.runnerRevision,
              p_sandbox_connection_revision: command.sandboxConnectionRevision,
              p_task_fixtures: command.taskFixtures,
              ...limits,
            });
      break;
    }
    default:
      request = admin.rpc("control_factory_benchmark_schedule", {
        ...scope,
        p_action: command.action,
      });
  }
  signal.throwIfAborted();
  const { data, error } = await request.abortSignal(signal);
  signal.throwIfAborted();
  if (error) throw scheduleRpcError(error.code);
  const result = scheduleSnapshotSchema.safeParse(data);
  if (!result.success || result.data.experimentId !== experimentId) {
    throw new Error("The benchmark schedule returned an invalid projection.");
  }
  return result.data;
}
