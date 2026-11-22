import { z } from "zod/v4";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";

const id = z.uuid();
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const instant = z.iso.datetime({ offset: true });
const resultText = z
  .string()
  .min(1)
  .max(640)
  .refine((text) => text.trim().length > 0 && isFactoryDefinitionText(text));

export const maximumDiagnosisMembers = 12;
export const maximumDiagnosisDurationMs = 60_000;

export const diagnosisResultSchema = z.strictObject({
  version: z.literal(1),
  summary: resultText,
  uncertainty: resultText,
  claims: z
    .array(
      z.strictObject({
        member_ids: z.array(id).min(1).max(8),
        inferred_cause: resultText,
        uncertainty: resultText,
      }),
    )
    .max(8),
});

export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;

export const diagnosisMemberSchema = z.object({
  member_id: id,
  session_id: id,
  run_id: id,
  run_attempt_count: z.number().int().positive(),
  stage_id: id.nullable(),
  stage_slug: z.string().min(1).max(200).nullable(),
  producing_agent_id: id,
  agent_prompt_revision_id: id,
  definition_revision_id: id.nullable(),
  execution_revision_id: id.nullable(),
  source_kind: z.enum(["scorer", "validation"]),
  evaluation_attempt_id: id.nullable(),
  scorer_revision_id: id.nullable(),
  validation_record_key: z.string().min(1).max(200).nullable(),
  target_commit_sha: sha,
  target_tree_sha: sha.nullable(),
});

export const diagnosisBudgetSchema = z.object({
  max_input_bytes: z.number().int().positive().max(40_000),
  max_output_tokens: z.number().int().positive().max(1_200),
  max_execution_ms: z.number().int().positive().max(maximumDiagnosisDurationMs),
});

const diagnosisSupportSchema = z.object({
  minimum_support: z.number().int().positive(),
  support_count: z.number().int().nonnegative().max(maximumDiagnosisMembers),
});

const diagnosisPinsSchema = z.object({
  agent_id: id,
  prompt_revision_id: id,
  prompt_sha256: digest,
  profile_revision_id: id,
  model_id: z
    .string()
    .max(160)
    .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/),
  definition_revision_id: id,
  definition_digest: digest,
  skill_revision_ids: z.array(id).max(20),
  budget: diagnosisBudgetSchema,
  ...diagnosisSupportSchema.shape,
});

export const diagnosisClaimSchema = z.object({
  workspace_id: id,
  factory_id: id,
  diagnosis_id: id,
  attempt_id: id,
  lease_id: id,
  lease_expires_at: instant,
});

export const diagnosisPreparationSchema = diagnosisPinsSchema.extend({
  evidence_digest: digest,
  evidence: z.array(diagnosisMemberSchema).min(1).max(maximumDiagnosisMembers),
  prompt_md: z.string().max(16_000).refine(isFactoryDefinitionText),
  provider_route: z
    .string()
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)?$/),
  symptom_kind: z.enum(["scorer", "validation"]),
});

export const diagnosisPermitSchema = z.object({
  encrypted_api_key: z.string().min(1).max(16_384),
  deadline_at: instant,
});

export const diagnosisRequestSchema = z.strictObject({
  requestId: id,
  promptRevisionId: id,
});

export const diagnosisTargetIdSchema = id;

export const diagnosisUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
  output_tokens: z.number().int().nonnegative().max(1_000_000_000).optional(),
  cost_usd: z.number().finite().nonnegative().max(1_000_000_000).optional(),
});

export const diagnosisTraceSchema = z.object({
  worker_runtime: z.enum(["node", "workerd"]).optional(),
  provider_model: z.string().max(160).optional(),
  provider_name: z.string().max(120).optional(),
  provider_request_id: z.string().max(200).optional(),
});

export const diagnosisReceiptSchema = diagnosisPinsSchema.extend({
  diagnosis_id: id,
  workspace_id: id,
  factory_id: id,
  cohort_id: id,
  symptom_kind: z.enum(["scorer", "validation"]),
  request_id: id,
  status: z.enum([
    "queued",
    "claimed",
    "running",
    "completed",
    "invalid_result",
    "provider_unavailable",
    "timeout",
    "budget_exhausted",
    "canceled",
    "lease_expired",
    "authorization_revoked",
    "evidence_unavailable",
  ]),
  requested_at: instant,
  finished_at: instant.nullable(),
  requested_by_member_id: id,
  evidence_digest: digest.nullable(),
  evidence_state: z.enum(["available", "unavailable"]),
  evidence: z.array(diagnosisMemberSchema).max(maximumDiagnosisMembers).nullable(),
  result: diagnosisResultSchema.nullable(),
  trace: diagnosisTraceSchema.nullable(),
  usage: diagnosisUsageSchema.nullable(),
});

export type DiagnosisClaim = z.infer<typeof diagnosisClaimSchema>;
export type DiagnosisPreparation = z.infer<typeof diagnosisPreparationSchema>;
export type DiagnosisTrace = z.infer<typeof diagnosisTraceSchema>;
export type DiagnosisUsage = z.infer<typeof diagnosisUsageSchema>;
