import { z } from "zod";

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();
const measure = z.number().nonnegative().nullable();

const canaryArmMetricsSchema = z.strictObject({
  assignedSessions: count,
  startedSessions: count,
  startedAttempts: count,
  succeededAttempts: count,
  failedAttempts: count,
  canceledAttempts: count,
  pendingAttempts: count,
  overriddenSessions: count,
  fallbackSessions: count,
  exposureMismatchSessions: count,
  measuredCostAttempts: count,
  estimatedCostAttempts: count,
  unavailableCostAttempts: count,
  pendingCostAttempts: count,
  knownSpendUsd: measure,
  completeSpendSessions: count,
  meanSpendUsd: measure,
  knownLatencySessions: count,
  meanLatencyMs: measure,
  scoredSessions: count,
  scorePasses: count,
  scoreFailures: count,
  scoreInconclusiveSessions: count,
  scorePendingSessions: count,
  scoreNotSampledSessions: count,
  unavailableScoreSessions: count,
  meanNumericScore: z.number().nullable(),
});

const reason = z.enum([
  "insufficient_enrollment",
  "insufficient_quality",
  "insufficient_spend",
  "insufficient_latency",
  "incomparable_scores",
  "incomplete_usage",
  "exposure_deviations",
]);

export const routingCanaryReportSchema = z.strictObject({
  canary: z.strictObject({
    id,
    activationNumber: count,
    baselineActivationNumber: count,
    candidateRevisionId: id,
    baselineRevisionId: id,
    taskClassId: id,
    taskClassSlug: z.string(),
    candidateBps: count.max(10_000),
    minimumSupport: count,
    createdAt: timestamp,
    scorerRevisionId: id.nullable(),
  }),
  window: z.strictObject({ from: timestamp, to: timestamp, asOf: timestamp }),
  status: z.enum(["comparable", "inconclusive"]),
  reasons: z.array(reason),
  outsideClassSessions: count,
  baseline: canaryArmMetricsSchema,
  candidate: canaryArmMetricsSchema,
});

export type RoutingCanaryArmMetrics = z.infer<typeof canaryArmMetricsSchema>;
export type RoutingCanaryReport = z.infer<typeof routingCanaryReportSchema>;
