import { z } from "zod";

import { factoryProposalUuidSchema as id } from "./contracts";
import { factoryImprovementPublicationSchema } from "./publication-contracts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const positiveInteger = z.number().int().positive().safe();
const time = z.string().datetime({ offset: true });

export const factoryImprovementAdoptionCommandSchema = z
  .object({
    publicationId: id,
    expectedActivationNumber: positiveInteger,
    candidateDigest: digest,
    headCommitSha: commit,
  })
  .strict();

export type FactoryImprovementAdoptionCommand = z.output<
  typeof factoryImprovementAdoptionCommandSchema
>;

export const factoryImprovementReviewProofSchema = z.object({
  repositoryNumericId: positiveInteger,
  pullNumber: positiveInteger,
  pullUrl: z.string().url(),
  baseCommitSha: commit,
  headCommitSha: commit,
  mergeCommitSha: commit,
  reviewerId: positiveInteger,
  reviewerLogin: z.string().min(1).max(80),
  reviewId: z.string().min(1).max(256),
  reviewedAt: time,
  mergedAt: time,
  observedAt: time,
});

export type FactoryImprovementReviewProof = z.output<typeof factoryImprovementReviewProofSchema>;

export const factoryImprovementAdoptionSchema = z.object({
  id,
  proposalId: id,
  proposalRevisionId: id,
  publicationId: id,
  validationId: id,
  actorMemberId: id,
  createdAt: time,
  baseline: factoryImprovementPublicationSchema.shape.base,
  adopted: factoryImprovementPublicationSchema.shape.base,
  review: factoryImprovementReviewProofSchema,
  comparisons: factoryImprovementPublicationSchema.shape.comparisons,
});

export type FactoryImprovementAdoption = z.output<typeof factoryImprovementAdoptionSchema>;
