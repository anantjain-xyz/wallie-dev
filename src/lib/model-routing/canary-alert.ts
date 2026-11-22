import { z } from "zod";

import { routingCanaryReportSchema } from "./canary-report";
import { routingDraftEvidenceSchema } from "./draft-contracts";

const id = z.string().uuid();

export const routingCanaryAlertSchema = z
  .strictObject({
    id,
    canaryId: id,
    activationNumber: z.number().int().positive(),
    ruleId: id,
    evidenceDraftId: id,
    evidence: routingDraftEvidenceSchema,
    thresholdRevision: z.literal(1),
    metric: z.enum(["pass_rate", "spend", "wall_time"]),
    thresholdBps: z.number().int().positive(),
    baselineValue: z.number().nonnegative(),
    candidateValue: z.number().nonnegative(),
    baselineSupport: z.number().int().nonnegative(),
    candidateSupport: z.number().int().nonnegative(),
    observedAt: z.string().datetime({ offset: true }),
    report: routingCanaryReportSchema,
  })
  .refine(
    ({ canaryId, activationNumber, ruleId, evidence, report }) =>
      canaryId === report.canary.id &&
      activationNumber === report.canary.activationNumber &&
      ruleId === evidence.ruleId &&
      evidence.scorerRevisionId === report.canary.scorerRevisionId,
  );

export type RoutingCanaryAlert = z.infer<typeof routingCanaryAlertSchema>;
