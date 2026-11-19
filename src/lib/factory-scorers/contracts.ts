import { z } from "zod";

export const factoryScorerEvidenceKindSchema = z.enum([
  "code_diff",
  "artifact",
  "validation_report",
  "browser_screenshot",
  "browser_recording",
]);

export type FactoryScorerEvidenceKind = z.infer<typeof factoryScorerEvidenceKindSchema>;

export const factoryScorerEvidenceRequirementsSchema = z
  .array(factoryScorerEvidenceKindSchema)
  .min(1)
  .max(factoryScorerEvidenceKindSchema.options.length)
  .refine((kinds) => new Set(kinds).size === kinds.length, {
    message: "Required evidence kinds must be unique.",
  })
  .readonly();

export const factoryScorerNumericValueSchema = z.number().min(-1_000_000_000).max(1_000_000_000);

const numericScoringSchema = z
  .strictObject({
    kind: z.literal("numeric"),
    min: factoryScorerNumericValueSchema,
    max: factoryScorerNumericValueSchema,
    direction: z.enum(["higher_is_better", "lower_is_better"]),
    passThreshold: factoryScorerNumericValueSchema,
    failThreshold: factoryScorerNumericValueSchema,
  })
  .superRefine((rule, context) => {
    if (rule.min >= rule.max) {
      context.addIssue({
        code: "custom",
        path: ["max"],
        message: "The maximum must be greater than the minimum.",
      });
      return;
    }
    for (const field of ["passThreshold", "failThreshold"] as const) {
      if (rule[field] < rule.min || rule[field] > rule.max) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "The threshold must be within the score range.",
        });
      }
    }

    const higherIsBetter = rule.direction === "higher_is_better";
    if (
      higherIsBetter
        ? rule.failThreshold >= rule.passThreshold
        : rule.failThreshold <= rule.passThreshold
    ) {
      context.addIssue({
        code: "custom",
        path: ["failThreshold"],
        message: "The inclusive pass and fail intervals must be disjoint.",
      });
    }
  });

const scoringSchema = z
  .union([
    z.strictObject({ kind: z.literal("boolean"), passValue: z.boolean() }),
    numericScoringSchema,
  ])
  .readonly();

export const factoryScorerDefinitionSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    rubric: z
      .string()
      .refine(
        (value) =>
          value.isWellFormed() &&
          !value.includes("\0") &&
          value.trim().length > 0 &&
          Array.from(value).length <= 20_000,
        "Use 1 to 20,000 characters of well-formed rubric text.",
      ),
    requiredEvidence: factoryScorerEvidenceRequirementsSchema,
    scoring: scoringSchema,
  })
  .readonly();

export type FactoryScorerDefinition = z.infer<typeof factoryScorerDefinitionSchema>;

export const factoryScorerEvidenceReferenceSchema = z
  .strictObject({
    kind: factoryScorerEvidenceKindSchema,
    id: z.string().uuid(),
  })
  .readonly();

export type FactoryScorerEvidenceReference = z.infer<typeof factoryScorerEvidenceReferenceSchema>;
