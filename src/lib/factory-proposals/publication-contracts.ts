import { z } from "zod";

import { factoryProposalUuidSchema as id } from "./contracts";

const definitionDigest = z.string().regex(/^[a-f0-9]{64}$/);
const gitSha = z.string().regex(/^[a-f0-9]{40}$/);
const safeInteger = z.number().int().positive().safe();

export const improvementPublicationTargetCommandSchema = z
  .object({
    repositoryId: id,
    baseBranch: z.string().trim().min(1).max(180),
  })
  .strict();
export type ImprovementPublicationTargetCommand = z.output<
  typeof improvementPublicationTargetCommandSchema
>;

export const improvementPublicationTargetSchema = improvementPublicationTargetCommandSchema.extend({
  id,
  configPath: z.string(),
});

const comparisonArm = z.object({
  passes: z.number().int().nonnegative(),
  passRateBps: z.number().nullable(),
  meanCostUsd: z.number().nonnegative().nullable(),
  p95LatencyMs: z.number().nonnegative().nullable(),
});
const qualifiedComparison = z.object({
  suiteRevisionId: id,
  experimentId: id,
  status: z.literal("qualified"),
  independentTasks: z.number().int().nonnegative(),
  plannedPairs: z.number().int().positive(),
  resolvedPairs: z.number().int().nonnegative(),
  coverageBps: z.number().min(0).max(10_000),
  baseline: comparisonArm,
  candidate: comparisonArm,
});

export const factoryImprovementPublicationSchema = z.object({
  id,
  proposalId: id,
  proposalRevisionId: id,
  validationId: id,
  createdAt: z.string().datetime({ offset: true }),
  base: z.object({ activationNumber: safeInteger, revisionId: id, digest: definitionDigest }),
  candidate: z.object({ revisionId: id, digest: definitionDigest }),
  cohort: z.object({
    id,
    diagnosisId: id,
    evidenceDigest: definitionDigest,
    citedCount: z.number().int().positive().max(12),
  }),
  comparisons: z.object({ targeted: qualifiedComparison, holdout: qualifiedComparison }),
  target: improvementPublicationTargetSchema.extend({
    repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    repositoryNumericId: safeInteger,
    installationId: safeInteger,
    headBranch: z.string(),
  }),
  baseCommitSha: gitSha.nullable(),
  baseTreeSha: gitSha.nullable(),
  headCommitSha: gitSha.nullable(),
  headTreeSha: gitSha.nullable(),
  creationArmed: z.boolean(),
  pullRequest: z
    .object({
      number: safeInteger,
      url: z.string().url(),
      state: z.enum(["open", "closed", "merged"]),
    })
    .nullable(),
  current: z.boolean(),
});

export type FactoryImprovementPublication = z.output<typeof factoryImprovementPublicationSchema>;
