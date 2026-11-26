import { z } from "zod";

import { benchmarkEvaluationPlanSchema } from "./experiment-evaluation-contracts";

const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const worker = z.enum(["node", "workerd"]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const sandbox = z.enum(["vercel", "e2b", "daytona"]);
const harness = z.enum(["codex", "claude-code", "cursor", "opencode"]);

export const benchmarkAxisCandidateSchema = z.strictObject({
  definitionRevisionId: id,
  qualificationId: id,
  workerRuntime: worker,
  expectedToolchainDigest: digest.optional(),
});

export const freezeBenchmarkAxesRequestSchema = z.strictObject({
  experimentId: id,
  suiteRevisionId: id,
  policyRevisionId: id,
  candidates: z
    .array(benchmarkAxisCandidateSchema)
    .min(2)
    .max(100)
    .refine(
      (candidates) =>
        new Set(
          candidates.map(
            ({ definitionRevisionId, qualificationId, workerRuntime }) =>
              `${definitionRevisionId}:${qualificationId}:${workerRuntime}`,
          ),
        ).size === candidates.length,
      "Select distinct comparison candidates.",
    ),
  repetitions: z.number().int().min(1).max(100),
  seed: z.number().int().min(0).max(2_147_483_647),
  timeoutMs: z.number().int().min(1_000).max(1_800_000),
  evaluation: benchmarkEvaluationPlanSchema.optional(),
});

export const benchmarkAxisSnapshotSchema = z.object({
  experimentId: id,
  suiteRevisionId: id,
  policyRevisionId: id,
  repetitions: z.number().int().positive(),
  taskCount: z.number().int().positive(),
  candidateCount: z.number().int().positive(),
  expectedTrialCount: z.number().int().positive(),
  materializedTrialCount: z.number().int().positive(),
  eligibleTrialCount: z.number().int().nonnegative(),
  ineligibleTrialCount: z.number().int().nonnegative(),
  evaluation: benchmarkEvaluationPlanSchema.optional(),
});

export const benchmarkAxisCatalogSchema = z.object({
  definitions: z.array(z.object({ id, digest, label: z.string(), isCurrent: z.boolean() })),
  scorerRevisions: z.array(
    z.object({ id, scorerName: z.string().min(1), revisionNumber: z.number().int().positive() }),
  ),
  policies: z.array(
    z.object({
      id,
      profile: z.enum(["blocked", "recorded_fixtures", "isolated_test"]),
      revisionNumber: z.number().int().positive(),
    }),
  ),
  profiles: z.array(
    z.object({
      id,
      modelKey: z.string(),
      harness,
      harnessModel: z.string(),
      workerRuntime: worker,
      sandboxProvider: sandbox,
      sandboxConnectionRevision: id,
      toolchain: z.string(),
      toolchainDigest: digest,
      connectionName: z.string().nullable(),
      checkedAt: z.string().nullable(),
      definitionIds: z.array(id),
      unavailableReason: z.string().nullable(),
    }),
  ),
});

export type BenchmarkAxisCatalog = z.infer<typeof benchmarkAxisCatalogSchema>;
export type BenchmarkAxisRequest = z.infer<typeof freezeBenchmarkAxesRequestSchema>;
export type BenchmarkAxisSnapshot = z.infer<typeof benchmarkAxisSnapshotSchema>;
