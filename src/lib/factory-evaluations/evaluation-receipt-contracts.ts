import { z } from "zod";

import { isFactoryDefinitionText } from "@/lib/factory-definitions/text";
import {
  factoryScorerEvidenceReferenceSchema,
  factoryScorerNumericValueSchema,
} from "@/lib/factory-scorers/contracts";
import { factoryScorerResultSchema } from "@/lib/factory-scorers/result";

export const maxJobEvaluationReceipts = 6;

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const natural = z.number().int().safe().nonnegative();
const cost = z.number().min(0).max(Number.MAX_SAFE_INTEGER);
const attemptCount = natural.max(maxJobEvaluationReceipts);
const usageProvenance = z.enum(["measured", "estimated", "unavailable"]);
const score = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("numeric"), value: factoryScorerNumericValueSchema }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
]);
const location = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("whole") }),
  z.strictObject({
    kind: z.literal("lines"),
    startLine: natural.min(1),
    endLine: natural.min(1),
  }),
  z.strictObject({ kind: z.literal("time"), startMs: natural, endMs: natural }),
]);

const evidenceLocation = z.strictObject({
  reference: factoryScorerEvidenceReferenceSchema,
  location,
});

const evaluationReceiptRecordSchema = z
  .object({
    attempt_id: id,
    workspace_id: id,
    factory_id: id,
    job_id: id,
    session_id: id,
    run_id: id,
    scorer_revision_id: id,
    sample_receipt_id: id,
    target_commit_sha: z.string().regex(/^[a-f0-9]{40}$/),
    attempt_number: natural.min(1).max(maxJobEvaluationReceipts),
    attempt_outcome: z.enum([
      "succeeded",
      "retryable_failure",
      "permanent_failure",
      "lease_expired",
      "canceled",
    ]),
    profile_revision_id: id.nullable(),
    provider_model: z.string().max(160).nullable(),
    provider_name: z.string().max(120).nullable(),
    provider_request_id: z.string().max(200).nullable(),
    adapter_runtime: z.literal("openrouter-chat-v1").nullable(),
    worker_runtime: z.enum(["node", "workerd"]).nullable(),
    evidence_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    status: z.enum(["pass", "fail", "inconclusive", "skipped", "error"]),
    reason: z
      .enum([
        "between_thresholds",
        "ambiguous_evidence",
        "missing_evidence",
        "unsupported_evidence",
        "evidence_unavailable",
        "profile_unavailable",
        "invalid_output",
        "provider_unavailable",
        "timeout",
        "judgment_unavailable",
        "lease_expired",
        "canceled",
      ])
      .nullable(),
    score: score.nullable(),
    result: factoryScorerResultSchema.nullable(),
    explanation: z.string().min(1).max(640).refine(isFactoryDefinitionText).nullable(),
    evidence_locations: z.array(evidenceLocation).max(5).nullable(),
    claimed_at: timestamp,
    started_at: timestamp.nullable(),
    finished_at: timestamp,
    latency_ms: natural,
    input_tokens: natural.nullable(),
    output_tokens: natural.nullable(),
    token_provenance: usageProvenance,
    cost_usd: cost.nullable(),
    cost_provenance: usageProvenance,
    estimation_revision: z.string().min(1).max(128).nullable(),
    evidence_availability: z.enum(["available", "withheld", "unavailable"]),
  })
  .refine((receipt) => {
    if (receipt.evidence_availability === "available") return true;
    return (
      receipt.result === null &&
      receipt.explanation === null &&
      receipt.evidence_locations === null &&
      receipt.evidence_digest === null
    );
  }, "Hidden evidence fields must be null.")
  .refine((receipt) => {
    const hasTokens = receipt.input_tokens !== null && receipt.output_tokens !== null;
    return (
      (receipt.input_tokens === null) === (receipt.output_tokens === null) &&
      (receipt.token_provenance !== "unavailable") === hasTokens &&
      (receipt.cost_provenance !== "unavailable") === (receipt.cost_usd !== null) &&
      ((receipt.token_provenance !== "estimated" && receipt.cost_provenance !== "estimated") ||
        receipt.estimation_revision !== null)
    );
  }, "Usage must match its provenance.")
  .refine(
    (receipt) => receipt.result === null || receipt.result.evidence.length <= 5,
    "An evaluation can reference up to five evidence kinds.",
  );

export const evaluationReceiptPageSchema = z.object({
  receipts: z.array(evaluationReceiptRecordSchema).max(maxJobEvaluationReceipts),
  next_finished_at: z.null(),
  next_attempt_id: z.null(),
  usage: z
    .object({
      attempt_count: attemptCount,
      input_tokens: natural.nullable(),
      output_tokens: natural.nullable(),
      token_unavailable_count: attemptCount,
      token_estimated_count: attemptCount,
      cost_usd: cost.nullable(),
      cost_unavailable_count: attemptCount,
      cost_estimated_count: attemptCount,
    })
    .refine((usage) => {
      const noTokenTotal = usage.attempt_count === 0 || usage.token_unavailable_count > 0;
      const noCostTotal = usage.attempt_count === 0 || usage.cost_unavailable_count > 0;
      return (
        (usage.input_tokens === null) === noTokenTotal &&
        (usage.output_tokens === null) === noTokenTotal &&
        (usage.cost_usd === null) === noCostTotal &&
        usage.token_unavailable_count + usage.token_estimated_count <= usage.attempt_count &&
        usage.cost_unavailable_count + usage.cost_estimated_count <= usage.attempt_count
      );
    }, "Usage totals must preserve each unavailable amount.")
    .nullable(),
});

export type FactoryEvaluationReceiptRecord = z.output<typeof evaluationReceiptRecordSchema>;
