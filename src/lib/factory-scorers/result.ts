import { z } from "zod";

import {
  type FactoryScorerDefinition,
  type FactoryScorerEvidenceReference,
  factoryScorerEvidenceReferenceSchema,
  factoryScorerEvidenceRequirementsSchema,
  factoryScorerNumericValueSchema,
} from "./contracts";

const evidenceSchema = z.array(factoryScorerEvidenceReferenceSchema).max(100);
const uniqueEvidence = (references: readonly FactoryScorerEvidenceReference[]) =>
  new Set(references.map(({ kind, id }) => `${kind}/${id.toLowerCase()}`)).size ===
  references.length;
const duplicateEvidenceError = { message: "Evidence references must be unique." };
const envelope = {
  schemaVersion: z.literal(1),
  evidence: evidenceSchema.refine(uniqueEvidence, duplicateEvidenceError).readonly(),
};
const scoredEnvelope = {
  ...envelope,
  evidence: evidenceSchema.min(1).refine(uniqueEvidence, duplicateEvidenceError).readonly(),
};

const numericScoreSchema = z
  .strictObject({ kind: z.literal("numeric"), value: factoryScorerNumericValueSchema })
  .readonly();
const booleanScoreSchema = z
  .strictObject({ kind: z.literal("boolean"), value: z.boolean() })
  .readonly();
const scoreSchema = z.union([numericScoreSchema, booleanScoreSchema]);
export { scoreSchema as factoryScorerScoreSchema };

const unscorableReason = z.enum(["ambiguous_evidence", "unsupported_evidence"]);
const skipReason = z.enum(["not_sampled", "excluded", "canceled"]);
const errorReason = z.enum(["invalid_output", "provider_unavailable", "timeout"]);

export const factoryScorerResultSchema = z
  .union([
    z.strictObject({ ...scoredEnvelope, status: z.literal("pass"), score: scoreSchema }),
    z.strictObject({ ...scoredEnvelope, status: z.literal("fail"), score: scoreSchema }),
    z.strictObject({
      ...scoredEnvelope,
      status: z.literal("inconclusive"),
      reason: z.literal("between_thresholds"),
      score: numericScoreSchema,
    }),
    z
      .strictObject({
        ...envelope,
        status: z.literal("inconclusive"),
        reason: z.literal("missing_evidence"),
        missingEvidence: factoryScorerEvidenceRequirementsSchema,
      })
      .refine(
        ({ evidence, missingEvidence }) =>
          !missingEvidence.some((kind) => evidence.some((reference) => reference.kind === kind)),
        { path: ["missingEvidence"], message: "Available evidence cannot also be missing." },
      ),
    z.strictObject({
      ...scoredEnvelope,
      status: z.literal("inconclusive"),
      reason: unscorableReason,
    }),
    z.strictObject({ ...envelope, status: z.literal("skipped"), reason: skipReason }),
    z.strictObject({ ...scoredEnvelope, status: z.literal("error"), reason: errorReason }),
  ])
  .readonly();

export type FactoryScorerResult = z.infer<typeof factoryScorerResultSchema>;

type ScoringOutcome =
  | { kind: "scored"; value: unknown }
  | { kind: "inconclusive"; reason: z.infer<typeof unscorableReason> }
  | { kind: "skipped"; reason: z.infer<typeof skipReason> }
  | { kind: "error"; reason: z.infer<typeof errorReason> };

function scoreOutcome(
  rule: FactoryScorerDefinition["scoring"],
  value: unknown,
):
  | { status: "pass" | "fail"; score: z.infer<typeof scoreSchema> }
  | {
      status: "inconclusive";
      reason: "between_thresholds";
      score: z.infer<typeof numericScoreSchema>;
    }
  | { status: "error"; reason: "invalid_output" } {
  if (rule.kind === "boolean") {
    if (typeof value !== "boolean") return { status: "error", reason: "invalid_output" };
    return {
      status: value === rule.passValue ? "pass" : "fail",
      score: { kind: "boolean", value },
    };
  }

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < rule.min ||
    value > rule.max
  ) {
    return { status: "error", reason: "invalid_output" };
  }

  const score = { kind: "numeric", value } as const;
  const higherIsBetter = rule.direction === "higher_is_better";
  if (higherIsBetter ? value >= rule.passThreshold : value <= rule.passThreshold) {
    return { status: "pass", score };
  }
  if (higherIsBetter ? value <= rule.failThreshold : value >= rule.failThreshold) {
    return { status: "fail", score };
  }
  return { status: "inconclusive", reason: "between_thresholds", score };
}

/** Resolves a verdict from one pinned definition and its available, already-authorized evidence. */
export function resolveFactoryScorerResult({
  definition,
  evidence,
  outcome,
}: {
  definition: FactoryScorerDefinition;
  evidence: readonly FactoryScorerEvidenceReference[];
  outcome: ScoringOutcome;
}): FactoryScorerResult {
  const captured = { schemaVersion: 1, evidence };
  if (outcome.kind === "skipped") {
    return factoryScorerResultSchema.parse({
      ...captured,
      status: "skipped",
      reason: outcome.reason,
    });
  }

  const availableKinds = new Set(evidence.map(({ kind }) => kind));
  const missingEvidence = definition.requiredEvidence.filter((kind) => !availableKinds.has(kind));
  if (missingEvidence.length > 0) {
    return factoryScorerResultSchema.parse({
      ...captured,
      status: "inconclusive",
      reason: "missing_evidence",
      missingEvidence,
    });
  }

  const result =
    outcome.kind === "scored"
      ? scoreOutcome(definition.scoring, outcome.value)
      : { status: outcome.kind, reason: outcome.reason };
  return factoryScorerResultSchema.parse({ ...captured, ...result });
}
