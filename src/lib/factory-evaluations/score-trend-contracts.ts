import { z } from "zod";

import {
  evaluationReceiptRecordSchema,
  factoryEvaluationScoreSchema,
} from "./evaluation-receipt-contracts";

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const count = z.number().int().safe().nonnegative();
const scorer = {
  scorer_id: id,
  scorer_revision_id: id,
  scorer_revision_number: count.min(1),
  scorer_name: z.string().min(1).max(120),
  scorer_slug: z.string().min(1).max(60),
};

export const scoreCohortSchema = z.object({
  ...scorer,
  policy_id: id,
  policy_revision_number: count.min(1),
  rate_bps: count.max(10_000),
  terminal_statuses: z
    .array(z.enum(["success", "error", "canceled"]))
    .min(1)
    .max(3),
  stage_ids: z.array(id).max(32),
  created_at: timestamp,
});
export type ScoreCohort = z.output<typeof scoreCohortSchema>;

export const scoreCohortPageSchema = z
  .object({
    cohorts: z.array(scoreCohortSchema).max(100),
    next_created_at: timestamp.nullable(),
    next_policy_id: id.nullable(),
  })
  .refine(
    ({ next_created_at, next_policy_id }) =>
      (next_created_at === null) === (next_policy_id === null),
  )
  .transform(({ cohorts, next_created_at, next_policy_id }) => ({
    cohorts,
    next:
      next_created_at && next_policy_id
        ? { createdAt: next_created_at, policyId: next_policy_id }
        : null,
  }));

const scoreMetricShape = {
  candidate_count: count,
  eligible_count: count,
  sampled_count: count,
  not_sampled_count: count,
  excluded_count: count,
  usable_count: count,
  decided_count: count,
  pass_count: count,
  fail_count: count,
  inconclusive_count: count,
  skipped_count: count,
  error_count: count,
  unsettled_count: count,
  missing_evidence_count: count,
  withheld_evidence_count: count,
  unsupported_evidence_count: count,
  mean_numeric_score: z.number().finite().nullable(),
};
const scoreMetricsSchema = z.object(scoreMetricShape);
export type ScoreMetrics = z.output<typeof scoreMetricsSchema>;

export const scoreTrendStatusSchema = z.enum([
  "excluded",
  "not_sampled",
  "unsettled",
  "pass",
  "fail",
  "inconclusive",
  "skipped",
  "error",
]);
const scoreTrendRowSchema = z.object({
  sample_receipt_id: id,
  run_id: id,
  session_id: id,
  run_finished_at: timestamp,
  target_commit_sha: sha.nullable(),
  sample_outcome: z.enum(["sampled", "not_sampled", "excluded"]),
  sample_reason: z.string().max(80).nullable(),
  evaluation_job_id: id.nullable(),
  evaluation_sample_receipt_id: id.nullable(),
  evaluation_attempt_id: id.nullable(),
  status: scoreTrendStatusSchema,
  reason: z.string().max(80).nullable(),
  score: factoryEvaluationScoreSchema.nullable(),
  evidence_availability: z.enum(["available", "withheld", "unavailable"]).nullable(),
});
export type ScoreTrendRow = z.output<typeof scoreTrendRowSchema>;

export const scoreSnapshotSchema = z.string().regex(/^[0-9]{1,20}\.[a-f0-9]{64}$/);
export const scoreTrendSchema = z.object({
  cohort: scoreCohortSchema,
  from: timestamp,
  to: timestamp,
  snapshot: scoreSnapshotSchema,
  totals: scoreMetricsSchema,
  points: z.array(z.object({ ...scoreMetricShape, bucket_at: timestamp })).max(366),
  rows: z.array(scoreTrendRowSchema).max(100),
  row_count: count,
  next_run_finished_at: timestamp.nullable(),
  next_run_id: id.nullable(),
});
export type ScoreTrend = z.output<typeof scoreTrendSchema>;

const runScoreSchema = z
  .object({
    ...scorer,
    evaluation_job_id: id.nullable(),
    job_status: z.enum(["queued", "claimed", "succeeded", "failed", "canceled"]).nullable(),
    sample_outcome: z.enum(["sampled", "not_sampled", "excluded"]),
    sample_reason: z.string().max(80).nullable(),
    source_attempt_id: id.nullable(),
    admission_paused: z.boolean(),
    receipt: evaluationReceiptRecordSchema.nullable(),
    diff: z
      .object({
        repository_full_name: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/),
        input_sha: sha,
        output_sha: sha,
      })
      .nullable(),
  })
  .refine(
    (row) =>
      (row.evaluation_job_id === null) === (row.job_status === null) &&
      (row.evaluation_job_id !== null || (row.receipt === null && row.diff === null)),
  );
export const runScoresSchema = z.array(runScoreSchema).max(32);
export type RunScore = z.output<typeof runScoreSchema>;
