import { z } from "zod";

import { factoryScorerScoreSchema } from "@/lib/factory-scorers/result";

import { benchmarkEvaluationPlanSchema } from "./experiment-evaluation-contracts";

const id = z.string().uuid().toLowerCase();
const count = z.number().int().nonnegative();
const spend = z.object({
  spentUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  unavailableCount: count,
});

const cursor = z.object({ trialId: id, scorerRevisionId: id });

export const benchmarkEvaluationPageQuerySchema = z
  .strictObject({
    afterTrialId: id.optional(),
    afterScorerRevisionId: id.optional(),
    limit: z
      .string()
      .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
      .transform(Number)
      .optional(),
  })
  .refine(({ afterTrialId, afterScorerRevisionId }) => !!afterTrialId === !!afterScorerRevisionId);

export const benchmarkEvaluationPageSchema = z
  .object({
    experimentId: id,
    evaluation: benchmarkEvaluationPlanSchema,
    scheduleState: z.enum(["unconfigured", "active", "paused", "canceled"]),
    eligibleTrialCount: count,
    denominator: count,
    spend: z.object({ execution: spend, evaluation: spend, combined: spend }),
    cells: z
      .array(
        cursor.extend({
          taskRevisionId: id,
          candidateKey: z.string().regex(/^[a-f0-9]{64}$/),
          repetition: z.number().int().min(1).max(100),
          status: z.enum([
            "pending",
            "pass",
            "fail",
            "inconclusive",
            "skipped",
            "error",
            "unavailable",
          ]),
          reason: z.string().max(120).nullable(),
          evaluationJobId: id.nullable(),
          attemptId: id.nullable(),
          score: factoryScorerScoreSchema.nullable(),
        }),
      )
      .max(100),
    nextCursor: cursor.nullable(),
  })
  .refine(
    ({ denominator, eligibleTrialCount, evaluation }) =>
      denominator === eligibleTrialCount * evaluation.scorerRevisionIds.length,
  );
