import { z } from "zod";

import {
  benchmarkComparisonIdSchema as id,
  MAX_BENCHMARK_COMPARISON_TRIALS,
} from "./comparison-contracts";

const count = z.number().int().nonnegative().max(MAX_BENCHMARK_COMPARISON_TRIALS);
const candidateKey = z.string().regex(/^[a-f0-9]{64}$/);
const basisPoints = z.number().int().min(0).max(10_000);
const minimumResolved = z.number().int().min(2).max(MAX_BENCHMARK_COMPARISON_TRIALS);
const repetitionCount = z.number().int().min(0).max(100);
const decimalUsd = z.string().regex(/^\d+(?:\.\d+)?$/);
const unsignedInteger = z
  .string()
  .regex(/^\d{1,5}$/)
  .transform(Number);

export const benchmarkFrontierQuerySchema = z.strictObject({
  scorerRevisionId: id.optional(),
  qualityFloorBps: unsignedInteger.pipe(basisPoints).default("8000"),
  minResolvedTrials: unsignedInteger.pipe(minimumResolved).default("2"),
  afterCandidateKey: candidateKey.optional(),
  limit: unsignedInteger.pipe(z.number().int().min(1).max(100)).default("50"),
});

const scorer = z.strictObject({
  id,
  scorerId: id,
  name: z.string(),
  revisionNumber: z.number().int().positive(),
});

const candidateIdentity = z.strictObject({
  candidateKey,
  position: z.number().int().positive().nullable(),
  plannedHarness: z.string(),
  plannedModel: z.string(),
});

const candidateCounts = z
  .strictObject({
    planned: count,
    eligible: count,
    excluded: count,
    started: count,
    terminal: count,
    comparable: count,
    resolved: count,
    scored: count,
    pass: count,
    fail: count,
    nonPassFailure: count,
    unresolved: count,
  })
  .refine(
    (counts) =>
      counts.planned === counts.eligible + counts.excluded &&
      counts.scored === counts.pass + counts.fail &&
      counts.resolved === counts.scored + counts.nonPassFailure,
  );

const candidate = candidateIdentity.extend({
  plannedRuntime: z.string(),
  counts: candidateCounts,
  quality: z.strictObject({
    passRateBps: basisPoints.nullable(),
    scoredPassRateBps: basisPoints.nullable(),
  }),
  cost: z.strictObject({
    measuredUsd: decimalUsd.nullable(),
    estimatedUsd: decimalUsd.nullable(),
    meanCostUsd: decimalUsd.nullable(),
    measuredTrials: count,
    estimatedTrials: count,
    unavailableTrials: count,
    pendingTrials: count,
    neverStartedTrials: count,
  }),
  spread: z.strictObject({
    qualityRepetitions: repetitionCount,
    costRepetitions: repetitionCount,
    minPassRateBps: basisPoints.nullable(),
    maxPassRateBps: basisPoints.nullable(),
    minMeanCostUsd: decimalUsd.nullable(),
    maxMeanCostUsd: decimalUsd.nullable(),
  }),
  status: z.enum(["excluded", "dominated", "frontier"]),
  isRecommended: z.boolean(),
  exclusions: z.array(
    z.enum([
      "no_scorer",
      "no_eligible_trials",
      "incomplete_execution",
      "incomplete_quality",
      "unverified_judge_profile",
      "mixed_judge_profile",
      "insufficient_samples",
      "unavailable_cost",
      "estimated_cost",
      "below_quality_floor",
    ]),
  ),
  dominatedBy: candidateIdentity.nullable(),
});

const recommendation = z
  .strictObject({
    status: z.enum(["recommended", "tied", "unavailable"]),
    reason: z.enum([
      "lowest_measured_cost",
      "equal_measured_cost_quality",
      "no_scorer",
      "no_eligible_trials",
      "comparison_in_progress",
      "mixed_judge_profile",
      "no_eligible_candidate",
    ]),
    candidates: z.array(candidateIdentity).max(8),
    candidateCount: count,
    meanCostUsd: decimalUsd.nullable(),
    passRateBps: basisPoints.nullable(),
  })
  .refine((decision) => {
    if (decision.status === "unavailable") {
      return (
        decision.candidateCount === 0 &&
        decision.candidates.length === 0 &&
        decision.meanCostUsd === null &&
        decision.passRateBps === null
      );
    }
    return (
      decision.candidateCount >= (decision.status === "tied" ? 2 : 1) &&
      decision.candidates.length === Math.min(8, decision.candidateCount) &&
      decision.meanCostUsd !== null &&
      decision.passRateBps !== null
    );
  });

export const benchmarkFrontierSchema = z
  .strictObject({
    experimentId: id,
    snapshotAt: z.string().datetime({ offset: true }),
    suite: z.strictObject({
      id,
      revisionId: id,
      revisionNumber: z.number().int().positive(),
      name: z.string(),
    }),
    policy: z.strictObject({
      revision: z.literal("measured-usd-v1"),
      qualityFloorBps: basisPoints,
      minimumResolved,
      costBasis: z.literal("execution_plus_selected_judge"),
    }),
    scorer: scorer.nullable(),
    scorers: z.array(scorer).max(16),
    cohort: z.strictObject({
      plannedTrialCount: count,
      eligibleTrialCount: count,
      excludedTrialCount: count,
      eligibleSlotCount: count,
      taskRevisionCount: count,
      repetitions: repetitionCount.min(1),
    }),
    candidateCount: count.min(1),
    frontierCount: count,
    recommendation,
    items: z.array(candidate).max(100),
    nextCursor: z.strictObject({ candidateKey }).nullable(),
  })
  .refine(({ cohort, candidateCount, frontierCount, recommendation, items, nextCursor }) => {
    return (
      cohort.plannedTrialCount === cohort.eligibleTrialCount + cohort.excludedTrialCount &&
      cohort.eligibleSlotCount <= cohort.eligibleTrialCount &&
      frontierCount <= candidateCount &&
      recommendation.candidateCount <= frontierCount &&
      items.length <= candidateCount &&
      items.every(({ isRecommended, status }) => !isRecommended || status === "frontier") &&
      new Set(items.map(({ candidateKey }) => candidateKey)).size === items.length &&
      (nextCursor === null || nextCursor.candidateKey === items.at(-1)?.candidateKey)
    );
  });

export type BenchmarkFrontier = z.infer<typeof benchmarkFrontierSchema>;
export type BenchmarkFrontierCandidate = z.infer<typeof candidate>;
export type BenchmarkFrontierQuery = z.output<typeof benchmarkFrontierQuerySchema>;
