import { z } from "zod";

import type { Tables } from "@/lib/supabase/database.types";

const requirementNames = z
  .array(z.string().trim().min(1).max(200))
  .max(100)
  .refine((values) => new Set(values).size === values.length, {
    message: "Requirement names must be unique.",
  });

/** Every requirement is explicit. Missing or unsupported configuration never passes. */
export const deliveryRequirementsSchema = z
  .object({
    version: z.literal(1),
    deliveryMode: z.enum(["code", "analysis"]),
    requiredChecks: requirementNames,
    minimumApprovals: z.number().int().min(0).max(20),
    requireCodeOwnerReview: z.boolean(),
    requireResolvedThreads: z.boolean(),
    requiredEvidence: requirementNames,
    freshnessSeconds: z.number().int().min(60).max(604_800),
    // A delivery decision can require artifact approval independently. It is
    // deliberately not an input to PR readiness, which would create a cycle.
    requireArtifactApprovalForDelivery: z.boolean(),
  })
  .strict();

export type DeliveryRequirements = z.infer<typeof deliveryRequirementsSchema>;

export const deliveryPolicyUpdateSchema = z
  .object({
    pipelineId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requirements: deliveryRequirementsSchema,
  })
  .strict();

export const deliveryPolicySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  pipelineId: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requirements: deliveryRequirementsSchema,
  createdAt: z.string().datetime({ offset: true }),
});

export const deliveryPolicyResponseSchema = z.object({
  policy: deliveryPolicySchema.nullable(),
});

export type DeliveryPolicy = z.infer<typeof deliveryPolicySchema>;

export function mapDeliveryPolicy(row: Tables<"delivery_policy_revisions">): DeliveryPolicy {
  return deliveryPolicySchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    pipelineId: row.pipeline_id,
    revision: row.revision,
    requirements: row.requirements,
    createdAt: row.created_at,
  });
}

/** Separate from pipeline phase status and generic artifact review decisions. */
export const PR_READINESS_STATES = [
  "unknown",
  "checking",
  "blocked",
  "ready",
  "merged",
  "closed",
  "not_applicable",
] as const;

export type PrReadinessState = (typeof PR_READINESS_STATES)[number];

/**
 * Minimal trusted evaluator receipt required before storing code Ready. This
 * validates the receipt shape; collectors/evaluators still own proving each
 * outcome from the configured requirements and exact revision evidence.
 */
export const readyVerificationSummarySchema = z.object({
  githubAccess: z.literal("available"),
  checks: z.literal("passed"),
  reviews: z.literal("passed"),
  evidence: z.literal("passed"),
  threads: z.literal("passed"),
});
