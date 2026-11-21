import { z } from "zod";

import { factoryScorerScoreSchema } from "@/lib/factory-scorers/result";

export const MAX_BENCHMARK_COMPARISON_TRIALS = 10_000;
export const BENCHMARK_COMPARISON_EXPORT_PAGE_SIZE = 32;
export const MAX_BENCHMARK_COMPARISON_EXPORT_PAGE_BYTES = 1024 * 1024;
export const MAX_BENCHMARK_COMPARISON_EXPORT_MANIFEST_BYTES = 2 * 1024 * 1024;
const maxExportPages = Math.ceil(
  MAX_BENCHMARK_COMPARISON_TRIALS / BENCHMARK_COMPARISON_EXPORT_PAGE_SIZE,
);

export const benchmarkComparisonIdSchema = z.string().uuid().toLowerCase();
const id = benchmarkComparisonIdSchema;
const timestamp = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(MAX_BENCHMARK_COMPARISON_TRIALS);
const attemptCount = z.number().int().nonnegative();
const positiveCount = count.min(1);
const label = z.string();
const milliseconds = z.number().nonnegative();
const repetition = z.number().int().min(1).max(100);
const positiveInteger = z.number().int().positive();
const seed = z.number().int().min(0).max(2_147_483_647);
const timeout = z.number().int().min(1_000).max(1_800_000);
const scheduleState = z.enum(["unconfigured", "active", "paused", "canceled"]);
const limit = z
  .string()
  .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
  .transform(Number);
const listLimit = limit.pipe(z.number().max(50)).optional();
const exportOrdinal = z.number().int().min(1).max(maxExportPages);
export const benchmarkComparisonExportOrdinalSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/)
  .transform(Number)
  .pipe(exportOrdinal);

export const benchmarkComparisonListQuerySchema = z
  .strictObject({
    suiteRevisionId: id.optional(),
    beforeCreatedAt: timestamp.optional(),
    beforeExperimentId: id.optional(),
    limit: listLimit,
  })
  .refine((query) => Boolean(query.beforeCreatedAt) === Boolean(query.beforeExperimentId));

export const benchmarkComparisonQuerySchema = z.strictObject({
  afterTrialId: id.optional(),
  limit: limit.optional(),
  afterCandidateKey: hash.optional(),
  candidateLimit: limit.optional(),
});

export const benchmarkComparisonExportListQuerySchema = z
  .strictObject({
    beforeCapturedAt: timestamp.optional(),
    beforeExportId: id.optional(),
    limit: listLimit,
  })
  .refine((query) => Boolean(query.beforeCapturedAt) === Boolean(query.beforeExportId));

export const benchmarkComparisonExportRequestSchema = z.strictObject({ requestId: id });

const revision = z.strictObject({
  id,
  revisionId: id,
  revisionNumber: positiveInteger,
  name: label,
});

const counts = z
  .strictObject({
    planned: count,
    eligible: count,
    excluded: count,
    admitted: count,
    started: count,
    pending: count,
    running: count,
    succeeded: count,
    failed: count,
    timedOut: count,
    canceled: count,
    unavailable: count,
    terminal: count,
  })
  .refine(
    (value) =>
      value.eligible + value.excluded === value.planned &&
      value.pending + value.running + value.terminal === value.eligible &&
      value.succeeded + value.failed + value.timedOut + value.canceled + value.unavailable ===
        value.terminal &&
      value.started <= value.admitted &&
      value.admitted <= value.eligible,
  );

const decimalUsd = z.string().regex(/^\d+(?:\.\d+)?$/);
const spendAxis = z.strictObject({
  measuredUsd: decimalUsd,
  estimatedUsd: decimalUsd,
  knownUsd: decimalUsd,
  reservedUsd: decimalUsd,
  unavailableHoldUsd: decimalUsd,
  measuredAttemptCount: attemptCount,
  estimatedAttemptCount: attemptCount,
  unavailableAttemptCount: attemptCount,
  pendingAttemptCount: attemptCount,
  neverStartedAttemptCount: attemptCount,
});
const spend = z.strictObject({
  execution: spendAxis,
  evaluation: spendAxis,
  combined: spendAxis,
  costUnavailableTrialCount: count,
});

const scoreStatus = z.enum([
  "pending",
  "pass",
  "fail",
  "inconclusive",
  "skipped",
  "error",
  "unavailable",
]);

const score = z.strictObject({
  scorerRevisionId: id,
  status: scoreStatus,
  reason: label.nullable(),
  attemptId: id.nullable(),
  score: factoryScorerScoreSchema.nullable(),
});

const quality = z
  .strictObject({
    scorerRevisionId: id,
    denominator: count,
    pending: count,
    pass: count,
    fail: count,
    inconclusive: count,
    skipped: count,
    error: count,
    unavailable: count,
  })
  .refine(
    (value) =>
      value.pending +
        value.pass +
        value.fail +
        value.inconclusive +
        value.skipped +
        value.error +
        value.unavailable ===
      value.denominator,
  );

const scorer = z.strictObject({
  id,
  scorerId: id,
  revisionNumber: positiveInteger,
  name: label,
  definitionDigest: hash,
});

const candidate = z.strictObject({
  candidateKey: hash,
  position: positiveInteger.nullable(),
  definitionRevisionId: id,
  definitionDigest: hash,
  qualificationId: id.nullable(),
  plannedHarness: label,
  plannedModel: label,
  plannedRuntime: label,
  sandboxProvider: label,
  sandboxConnectionRevision: id.nullable(),
  canonicalModelKey: label.nullable(),
  toolchain: label.nullable(),
  toolchainDigest: hash.nullable(),
  counts,
  spend,
  latency: z.strictObject({
    sampleCount: count,
    medianMs: milliseconds.nullable(),
    p95Ms: milliseconds.nullable(),
  }),
  quality: z.array(quality).max(16),
});

const trial = z.strictObject({
  trialId: id,
  task: revision,
  candidateKey: hash,
  candidatePosition: positiveInteger.nullable(),
  plannedHarness: label,
  plannedModel: label,
  repetition,
  seed,
  timeoutMs: timeout,
  eligibility: z.enum(["eligible", "ineligible", "unverified"]),
  eligibilityReason: label.nullable(),
  status: z.enum([
    "excluded",
    "pending",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "canceled",
    "unavailable",
  ]),
  reason: label.nullable(),
  admitted: z.boolean(),
  started: z.boolean(),
  runId: id.nullable(),
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  deadlineAt: timestamp.nullable(),
  wallRuntimeMs: milliseconds.nullable(),
  deadlineElapsed: z.boolean(),
  resultDigest: hash.nullable(),
  actualRunner: z
    .strictObject({
      runnerRevision: label,
      workerRuntime: label.nullable(),
      modelProvider: label.nullable(),
      modelName: label.nullable(),
    })
    .nullable(),
  spend: spend.extend({ costUnavailableTrialCount: count.max(1) }),
  scores: z.array(score).max(16),
});

const comparisonListItem = z.strictObject({
  experimentId: id,
  createdAt: timestamp,
  suite: revision,
  repetitions: repetition,
  counts,
  scheduleState,
});

export const benchmarkComparisonListSchema = z.strictObject({
  items: z.array(comparisonListItem).max(50),
  nextCursor: z.strictObject({ createdAt: timestamp, experimentId: id }).nullable(),
});

const summary = comparisonListItem.extend({
  policyRevisionId: id,
  policyDigest: hash,
  seed,
  timeoutMs: timeout,
  spend,
  scorers: z.array(scorer).max(16),
  candidateCount: positiveCount,
});

export const benchmarkComparisonSchema = summary
  .extend({
    candidates: z.array(candidate).max(100),
    nextCandidateCursor: z.strictObject({ candidateKey: hash }).nullable(),
    trialRows: z.array(trial).max(100),
    nextCursor: z.strictObject({ trialId: id }).nullable(),
  })
  .refine(
    (value) =>
      value.candidates.length <= value.candidateCount &&
      new Set(value.candidates.map(({ candidateKey }) => candidateKey)).size ===
        value.candidates.length &&
      (value.nextCandidateCursor === null ||
        value.nextCandidateCursor.candidateKey === value.candidates.at(-1)?.candidateKey) &&
      new Set(value.trialRows.map(({ trialId }) => trialId)).size === value.trialRows.length &&
      (value.nextCursor === null || value.nextCursor.trialId === value.trialRows.at(-1)?.trialId),
  );

export const benchmarkComparisonExportReceiptSchema = z
  .strictObject({
    exportId: id,
    capturedAt: timestamp,
    expiresAt: timestamp,
    trialCount: positiveCount,
    pageCount: exportOrdinal,
    candidateCount: positiveCount,
    candidatePageCount: exportOrdinal,
  })
  .refine(
    ({ pageCount, trialCount, candidateCount, candidatePageCount }) =>
      pageCount === Math.ceil(trialCount / BENCHMARK_COMPARISON_EXPORT_PAGE_SIZE) &&
      candidatePageCount === Math.ceil(candidateCount / BENCHMARK_COMPARISON_EXPORT_PAGE_SIZE),
  );

export const benchmarkComparisonExportListSchema = z.strictObject({
  experimentId: id,
  items: z.array(benchmarkComparisonExportReceiptSchema).max(50),
  nextCursor: z.strictObject({ capturedAt: timestamp, exportId: id }).nullable(),
});

const exportPageDescriptor = z.strictObject({
  ordinal: exportOrdinal,
  sha256: hash,
  sizeBytes: positiveInteger.max(MAX_BENCHMARK_COMPARISON_EXPORT_PAGE_BYTES),
});

export const benchmarkComparisonExportManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    exportId: id,
    workspaceId: id,
    factoryId: id,
    experimentId: id,
    capturedAt: timestamp,
    expiresAt: timestamp,
    summary,
    trialIds: z.array(id).min(1).max(MAX_BENCHMARK_COMPARISON_TRIALS),
    pages: z
      .array(
        exportPageDescriptor.extend({
          firstTrialId: id,
          lastTrialId: id,
          trialCount: positiveCount.max(BENCHMARK_COMPARISON_EXPORT_PAGE_SIZE),
        }),
      )
      .min(1)
      .max(maxExportPages),
    candidatePages: z
      .array(
        exportPageDescriptor.extend({
          firstCandidateKey: hash,
          lastCandidateKey: hash,
          candidateCount: positiveCount.max(BENCHMARK_COMPARISON_EXPORT_PAGE_SIZE),
        }),
      )
      .min(1)
      .max(maxExportPages),
  })
  .refine((manifest) => {
    let offset = 0;
    for (const [index, page] of manifest.pages.entries()) {
      if (
        page.ordinal !== index + 1 ||
        page.firstTrialId !== manifest.trialIds[offset] ||
        page.lastTrialId !== manifest.trialIds[offset + page.trialCount - 1]
      )
        return false;
      offset += page.trialCount;
    }
    return (
      manifest.summary.experimentId === manifest.experimentId &&
      manifest.summary.counts.planned === manifest.trialIds.length &&
      offset === manifest.trialIds.length &&
      new Set(manifest.trialIds).size === manifest.trialIds.length &&
      manifest.candidatePages.every(({ ordinal }, index) => ordinal === index + 1) &&
      manifest.candidatePages.reduce((total, { candidateCount }) => total + candidateCount, 0) ===
        manifest.summary.candidateCount
    );
  });

const exportPage = z.strictObject({
  schemaVersion: z.literal(1),
  exportId: id,
  ordinal: exportOrdinal,
});

export const benchmarkComparisonExportPageSchema = z.discriminatedUnion("kind", [
  exportPage.extend({
    kind: z.literal("trials"),
    trialRows: z.array(trial).min(1).max(BENCHMARK_COMPARISON_EXPORT_PAGE_SIZE),
  }),
  exportPage.extend({
    kind: z.literal("candidates"),
    candidates: z.array(candidate).min(1).max(BENCHMARK_COMPARISON_EXPORT_PAGE_SIZE),
  }),
]);

export type BenchmarkComparison = z.infer<typeof benchmarkComparisonSchema>;
export type BenchmarkComparisonList = z.infer<typeof benchmarkComparisonListSchema>;
export type BenchmarkComparisonTrial = z.infer<typeof trial>;
export type BenchmarkComparisonCandidate = z.infer<typeof candidate>;
export type BenchmarkComparisonExportPart = Pick<
  z.infer<typeof benchmarkComparisonExportPageSchema>,
  "kind" | "ordinal"
>;
export type BenchmarkComparisonExportList = z.infer<typeof benchmarkComparisonExportListSchema>;
export type BenchmarkComparisonExportReceipt = z.infer<
  typeof benchmarkComparisonExportReceiptSchema
>;
