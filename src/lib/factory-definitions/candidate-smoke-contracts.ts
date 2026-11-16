import { z } from "zod";

import { SANDBOX_PROVIDERS } from "@/lib/sandbox-connections/contracts";

import { factoryDefinitionExpectedActivationSchema } from "./schema";

export const candidateSmokeDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const candidateSmokeIdSchema = z.string().uuid();
const targetKindSchema = z.enum(["draft", "revision"]);
const targetSchema = z.object({ kind: targetKindSchema, id: candidateSmokeIdSchema }).strict();

export const candidateSmokeStartSchema = z
  .object({
    target: targetSchema,
    expectedActivationNumber: factoryDefinitionExpectedActivationSchema,
    expectedDigest: candidateSmokeDigestSchema,
  })
  .strict();

export const candidateSmokeHistoryQuerySchema = z
  .object({
    targetKind: targetKindSchema,
    targetId: candidateSmokeIdSchema,
    digest: candidateSmokeDigestSchema,
  })
  .strict()
  .transform(({ targetKind, targetId, digest }) => ({
    target: { kind: targetKind, id: targetId },
    digest,
  }));

export const candidateSmokeCancelQuerySchema = z
  .object({ digest: candidateSmokeDigestSchema })
  .strict();

const statusSchema = z.enum(["running", "passed", "blocked", "failed", "unsupported", "canceled"]);
const evidenceSchema = z.object({
  runtimeProfile: z.enum([...SANDBOX_PROVIDERS, "fake"]).optional(),
  stageCount: z.number().int().nonnegative().optional(),
  completedStageCount: z.number().int().nonnegative().optional(),
  cleanupPending: z.boolean().optional(),
  stages: z
    .array(
      z.object({
        stageId: candidateSmokeIdSchema,
        promptDigest: candidateSmokeDigestSchema,
      }),
    )
    .optional(),
  reason: z.string().max(100).optional(),
});

const candidateSmokeTestSchema = z.object({
  id: candidateSmokeIdSchema,
  target: targetSchema,
  definitionDigest: candidateSmokeDigestSchema,
  baseActivationNumber: factoryDefinitionExpectedActivationSchema,
  policyVersion: z.number().int().positive(),
  status: statusSchema,
  createdAt: z.string().datetime({ offset: true }),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  evidence: evidenceSchema.nullable(),
  error: z.string().nullable(),
});

export const candidateSmokeTestResponseSchema = z.object({ test: candidateSmokeTestSchema });
export const candidateSmokeHistoryResponseSchema = z.object({
  tests: z.array(candidateSmokeTestSchema),
});

export { candidateSmokeTestSchema };
export type CandidateSmokeStart = z.infer<typeof candidateSmokeStartSchema>;
export type CandidateSmokeTest = z.infer<typeof candidateSmokeTestSchema>;
