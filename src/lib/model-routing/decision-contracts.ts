import { z } from "zod";

import { pipelineStageFields } from "@/lib/pipeline/stage-schema";

import { modelRoutingConfigurationSchema } from "./contracts";

const id = z.string().uuid().toLowerCase();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const failureReason = z.enum([
  "ambiguous_class",
  "ambiguous_rule",
  "authority_unavailable",
  "confidence_unavailable",
  "configuration_unavailable",
  "cost_unavailable",
  "credential_unavailable",
  "evidence_unavailable",
  "invalid_policy",
  "latency_unavailable",
  "no_rule",
  "qualification_unavailable",
  "repository_mismatch",
  "threshold_not_met",
  "unmatched_class",
]);

const evaluationFields = z.strictObject({
  version: z.literal(1),
  taskClassSlug: z.string().nullable(),
  taskClassId: id.nullable(),
  ruleId: id.nullable(),
  initialReason: failureReason.nullable(),
});

const selectedEvaluation = evaluationFields.extend({
  disposition: z.literal("selected"),
  source: z.enum(["primary", "rule_fallback", "unmatched_fallback"]),
  reason: z.literal("qualified"),
  configuration: modelRoutingConfigurationSchema,
  benchmarkCandidateKey: digest,
});

const escalatedEvaluation = evaluationFields.extend({
  disposition: z.literal("escalated"),
  source: z.null(),
  reason: failureReason,
  configuration: z.null(),
  benchmarkCandidateKey: z.null(),
});

export const routingDecisionEvaluationSchema = z.discriminatedUnion("disposition", [
  selectedEvaluation,
  escalatedEvaluation,
]);

const admissionFields = {
  mode: z.literal("shadow"),
  policyRevisionId: id,
  policyDigest: digest,
};

export const routingDecisionSchema = z.discriminatedUnion("disposition", [
  selectedEvaluation.extend(admissionFields),
  escalatedEvaluation.extend(admissionFields),
]);

export type RoutingDecisionEvaluation = z.infer<typeof routingDecisionEvaluationSchema>;

export const routingDecisionReasonLabels = {
  qualified: "The configuration met the routing requirements.",
  ambiguous_class: "More than one task class matches this slug.",
  ambiguous_rule: "More than one rule matches this task class.",
  authority_unavailable: "The configuration's execution authority is unavailable.",
  confidence_unavailable: "The benchmark has no comparable confidence measurement.",
  configuration_unavailable: "The exact benchmark configuration is unavailable.",
  cost_unavailable: "Measured cost is missing from the benchmark evidence.",
  credential_unavailable: "The required credential is unavailable.",
  evidence_unavailable: "The benchmark has no complete, comparable evidence for this scorer.",
  invalid_policy: "The routing policy is invalid.",
  latency_unavailable: "Measured latency is missing from the benchmark evidence.",
  no_rule: "This task class has no routing rule.",
  qualification_unavailable: "The configuration's capability qualification is unavailable.",
  repository_mismatch: "The configuration was qualified for a different repository.",
  threshold_not_met: "The benchmark did not meet the routing thresholds.",
  unmatched_class: "No task class matches this slug.",
} satisfies Record<RoutingDecisionEvaluation["reason"], string>;

export const routingPreviewRequestSchema = z.strictObject({
  expectedActivationNumber: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  draftId: id,
  taskClassSlug: pipelineStageFields.slug,
});

export const routingPreviewResponseSchema = z.strictObject({
  draftId: id,
  draftDigest: digest,
  decision: routingDecisionEvaluationSchema.nullable(),
});
