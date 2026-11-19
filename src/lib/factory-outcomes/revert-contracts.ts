import { z } from "zod/v4";

const uuid = z.uuid().toLowerCase();
const pullRequestNumber = z.number().int().positive().max(2_147_483_647);
const timestamp = z.iso.datetime({ offset: true });
const baseBranch = z.string().min(1).max(1024);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const relationshipStatus = z.enum(["candidate", "confirmed", "invalidated"]);

export const factoryRevertRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("relationship"),
    originalMergeId: uuid,
    revertPrNumber: pullRequestNumber,
    expectedRevision: z.number().int().min(0).max(2_147_483_646),
    requestId: uuid,
    status: relationshipStatus,
  }),
  z.strictObject({
    action: z.literal("coverage"),
    repositoryId: uuid,
    baseBranch,
    from: timestamp,
    through: timestamp,
    requestId: uuid,
  }),
  z.strictObject({
    action: z.literal("withdrawCoverage"),
    coverageId: uuid,
  }),
]);

export const githubRevertRepositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine((name) => name.split("/").every((segment) => segment !== "." && segment !== ".."));

export const factoryRevertTargetSchema = z.object({
  mergeId: uuid,
  observationId: uuid,
  repositoryId: uuid,
  repositoryNumericId: z.number().int().positive(),
  repositoryFullName: githubRevertRepositoryNameSchema,
  installationId: z.number().int().positive(),
  baseBranch,
  pullRequestNumber,
  mergeCommitSha: sha,
  mergedAt: timestamp,
});

export type FactoryRevertTarget = z.output<typeof factoryRevertTargetSchema>;

export const factoryRevertRelationshipReceiptSchema = z.object({
  id: uuid,
  originalMergeId: uuid,
  originalObservationId: uuid,
  originalMergeSha: sha,
  originalMergedAt: timestamp,
  revertPrNumber: pullRequestNumber,
  revision: z.number().int().positive().max(2_147_483_647),
  status: relationshipStatus,
  revertMergeSha: sha.nullable(),
  revertMergedAt: timestamp.nullable(),
  observedAt: timestamp,
  actorMemberId: uuid,
});

export const factoryRevertCoverageReceiptSchema = z.object({
  id: uuid,
  repositoryId: uuid,
  baseBranch,
  from: timestamp,
  through: timestamp,
  recordedAt: timestamp,
  withdrawnAt: timestamp.nullable(),
  actorMemberId: uuid,
});
