import "server-only";

import { z } from "zod";

import { MAX_BENCHMARK_COMPARISON_TRIALS } from "@/lib/factory-benchmarks/comparison-contracts";
import {
  benchmarkAxisCandidateSchema,
  freezeBenchmarkAxesRequestSchema,
} from "@/lib/factory-benchmarks/experiment-axes-contracts";
import { benchmarkEvaluationPlanSchema } from "@/lib/factory-benchmarks/experiment-evaluation-contracts";
import { configureLiveBenchmarkScheduleSchema } from "@/lib/factory-benchmarks/schedule";

import { factoryProposalBaseSchema, factoryProposalUuidSchema } from "./contracts";

const id = factoryProposalUuidSchema;
const workerdCandidate = benchmarkAxisCandidateSchema.extend({
  workerRuntime: z.literal("workerd"),
});
const orderedAxes = z
  .tuple([workerdCandidate, workerdCandidate])
  .refine(
    ([base, candidate]) => base.definitionRevisionId !== candidate.definitionRevisionId,
    "Select distinct baseline and candidate definition revisions.",
  );

const schedule = configureLiveBenchmarkScheduleSchema.shape;
const executionFields = z.strictObject({
  repetitions: freezeBenchmarkAxesRequestSchema.shape.repetitions,
  seed: freezeBenchmarkAxesRequestSchema.shape.seed,
  timeoutMs: freezeBenchmarkAxesRequestSchema.shape.timeoutMs,
  inferenceConnectionRevision: schedule.inferenceConnectionRevision,
  executionReserveUsd: schedule.executionReserveUsd,
  evaluationReserveUsd: schedule.evaluationReserveUsd.positive(),
  evaluationBudgetLimitUsd: benchmarkEvaluationPlanSchema.shape.budgetLimitUsd.positive(),
  targetedBudgetLimitUsd: schedule.budgetLimitUsd.positive(),
  holdoutBudgetLimitUsd: schedule.budgetLimitUsd.positive(),
  factoryConcurrencyLimit: schedule.factoryConcurrencyLimit,
  maxAdmittedTrials: schedule.maxAdmittedTrials,
});
const execution = executionFields.refine(
  (value) =>
    value.executionReserveUsd <=
      Math.min(value.targetedBudgetLimitUsd, value.holdoutBudgetLimitUsd) &&
    value.evaluationReserveUsd <= value.evaluationBudgetLimitUsd,
  "The suite and evaluation budgets must cover one trial reservation.",
);

const measuredBps = z.number().min(0).max(10_000);
const rateBps = measuredBps.int();
const permittedIncreaseBps = z.number().int().min(0).max(100_000);
const thresholds = z.strictObject({
  minimumIndependentTasks: z.number().int().min(2).max(500),
  minimumCoverageBps: rateBps.min(1),
  minimumCandidatePassRateBps: rateBps,
  maxPassRateDropBps: rateBps,
  maxMeanCostIncreaseBps: permittedIncreaseBps,
  maxP95LatencyIncreaseBps: permittedIncreaseBps,
});

export const factoryImprovementValidationCommandSchema = z
  .strictObject({
    requestId: id,
    targetedSuiteRevisionId: id,
    holdoutSuiteRevisionId: id,
    policyRevisionId: id,
    scorerRevisionId: id,
    candidates: orderedAxes,
    execution,
    thresholds,
  })
  .refine(
    (value) => value.targetedSuiteRevisionId !== value.holdoutSuiteRevisionId,
    "Select different targeted and held-out suite revisions.",
  );

export type FactoryImprovementValidationCommand = z.infer<
  typeof factoryImprovementValidationCommandSchema
>;

const comparisonStatus = z.enum(["qualified", "failed", "inconclusive"]);
const count = z.number().int().min(0).max(MAX_BENCHMARK_COMPARISON_TRIALS);
const candidateKey = factoryProposalBaseSchema.shape.digest;
const measurements = z.object({
  candidateKey,
  plannedTrials: count,
  resolvedTrials: count,
  passes: count,
  measuredCostTrials: count,
  measuredLatencyTrials: count,
  passRateBps: measuredBps.nullable(),
  meanCostUsd: z.number().nonnegative().nullable(),
  p95LatencyMs: z.number().nonnegative().nullable(),
});

const suiteComparison = z.object({
  suiteRevisionId: id,
  experimentId: id,
  scheduleState: z.enum(["unconfigured", "active", "paused", "canceled"]),
  status: comparisonStatus,
  reasons: z.array(z.string()),
  independentTasks: count,
  plannedPairs: count,
  resolvedPairs: count,
  coverageBps: measuredBps,
  regressions: count,
  baseline: measurements,
  candidate: measurements,
});

const timestamp = z.string().datetime({ offset: true });
export const factoryImprovementValidationReceiptSchema = z
  .object({
    id,
    proposalId: id,
    proposalRevisionId: id,
    requestId: id,
    createdAt: timestamp,
    authorMemberId: id,
    asOf: timestamp,
    base: factoryProposalBaseSchema,
    candidate: factoryProposalBaseSchema.pick({ revisionId: true, digest: true }),
    policyRevisionId: id,
    scorerRevisionId: id,
    axes: orderedAxes,
    thresholds,
    execution,
    status: z.enum([...comparisonStatus.options, "stale"]),
    reasons: z.array(z.string()),
    targeted: suiteComparison,
    holdout: suiteComparison,
  })
  .refine(
    (value) =>
      value.base.revisionId === value.axes[0].definitionRevisionId &&
      value.candidate.revisionId === value.axes[1].definitionRevisionId &&
      value.targeted.suiteRevisionId !== value.holdout.suiteRevisionId &&
      value.targeted.experimentId !== value.holdout.experimentId &&
      (value.status !== "qualified" ||
        (value.targeted.status === "qualified" && value.holdout.status === "qualified")),
    "The validation receipt does not match a single exact comparison.",
  );

export type FactoryImprovementValidationReceipt = z.infer<
  typeof factoryImprovementValidationReceiptSchema
>;
