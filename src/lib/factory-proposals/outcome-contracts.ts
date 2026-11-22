import { z } from "zod";

import { factoryImprovementAdoptionSchema } from "./adoption-contracts";
import { factoryProposalUuidSchema as id } from "./contracts";

const count = z.number().int().nonnegative().safe();
const activationNumber = count.positive();
const basisPoints = count.max(10_000);
const time = z.string().datetime({ offset: true });

const cohort = factoryImprovementAdoptionSchema.shape.baseline.extend({
  admittedSessions: count,
  startedSessions: count,
  approvedSessions: count,
  exhaustedSessions: count,
  unresolvedSessions: count,
  verifiedMerges: count,
  approvalRateBps: basisPoints.nullable(),
  approvalLimitsBps: z.object({ lower: basisPoints, upper: basisPoints }).nullable(),
  spend: z.object({
    state: z.enum(["no_attempts", "unavailable", "partial", "estimated", "measured"]),
    knownUsd: z.number().finite().nonnegative().nullable(),
    measuredAttempts: count,
    estimatedAttempts: count,
    unavailableAttempts: count,
    pendingAttempts: count,
  }),
});

export const factoryImprovementOutcomesSchema = z.object({
  adoptionId: id,
  observedAt: time,
  status: z.enum(["observed", "degraded", "inconclusive"]),
  minimumCompleted: activationNumber,
  reasons: z.array(z.enum(["insufficient_completed_sessions", "incomplete_outcome_coverage"])),
  baseline: cohort,
  candidate: cohort,
  restore: z.object({
    eligible: z.boolean(),
    receipt: z
      .object({
        activationNumber,
        previousActivationNumber: activationNumber,
        targetActivationNumber: activationNumber,
        targetRevisionId: id,
        restoredMode: z.enum(["shadow", "reviewed"]),
        createdAt: time,
      })
      .nullable(),
  }),
});

export type FactoryImprovementOutcomes = z.output<typeof factoryImprovementOutcomesSchema>;
