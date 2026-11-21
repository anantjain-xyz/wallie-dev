import { z } from "zod";

import { modelRoutingConstraintsSchema, routingTaskClassDetailsSchema } from "./contracts";

const id = z.string().uuid().toLowerCase();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(2).max(10_000);

export const routingDraftRequestSchema = z.strictObject({
  requestId: id,
  candidateKey: hash,
  scorerRevisionId: id,
  suiteRevisionId: id,
  taskClass: routingTaskClassDetailsSchema,
  constraints: modelRoutingConstraintsSchema,
});

export const routingDraftResponseSchema = z.strictObject({
  draftId: id,
  canonicalDigest: hash,
});

export const routingDraftEvidenceSchema = z.strictObject({
  version: z.literal(1),
  experimentId: id,
  candidateKey: hash,
  suite: z.strictObject({
    id,
    revisionId: id,
    purpose: z.enum(["regression", "holdout"]),
    name: z.string(),
  }),
  scorerRevisionId: id,
  scorerName: z.string(),
  taskClassName: z.string(),
  definitionDigest: hash,
  replayPolicyRevisionId: id,
  replayPolicyDigest: hash,
  ruleId: id,
  capturedAt: z.string().datetime({ offset: true }),
  qualityPassRateBps: z.number().int().min(0).max(10_000),
  resolvedTrials: count,
  measuredMeanCostUsd: z.string().regex(/^\d+(?:\.\d+)?$/),
  constraints: modelRoutingConstraintsSchema,
  p95WallLatencyMs: z.number().int().nonnegative().nullable(),
  isRecommended: z.boolean(),
});

export type RoutingDraftRequest = z.infer<typeof routingDraftRequestSchema>;
export type RoutingDraftEvidence = z.infer<typeof routingDraftEvidenceSchema>;
