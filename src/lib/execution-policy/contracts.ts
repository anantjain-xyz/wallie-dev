import { z } from "zod";

import type { Tables } from "@/lib/supabase/database.types";

/** Every execution limit is explicit. Nullable telemetry limits mean no configured cap. */
export const executionRequirementsSchema = z
  .object({
    version: z.literal(1),
    maxRepairAttempts: z.number().int().min(0).max(100),
    maxExecutionMs: z.number().int().min(1_000).max(86_400_000),
    maxTotalTokens: z.number().int().min(1).max(1_000_000_000_000).nullable(),
    maxCostUsd: z.number().min(0.000001).max(1_000_000).nullable(),
  })
  .strict();

export type ExecutionRequirements = z.infer<typeof executionRequirementsSchema>;

export const executionPolicyUpdateSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requirements: executionRequirementsSchema,
  })
  .strict();

export const executionPolicySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requirements: executionRequirementsSchema,
  createdAt: z.string().datetime({ offset: true }),
});

export const executionPolicyResponseSchema = z.object({
  policy: executionPolicySchema.nullable(),
});

export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export function mapExecutionPolicy(row: Tables<"execution_policy_revisions">): ExecutionPolicy {
  return executionPolicySchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    requirements: row.requirements,
    createdAt: row.created_at,
  });
}
