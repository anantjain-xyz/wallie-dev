import { z } from "zod";

export const LEADING_ACCEPTED_SCOPE_DIRECTIVE =
  /^<!-- wallie-accepted-scope: ([A-Za-z0-9_-]+) -->\n/;

const id = z.string().uuid();
const artifactVersion = z.number().int().positive().max(2_147_483_647);
const reviewRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const sessionSpecificationStateSchema = z.object({
  stageId: id,
  artifactId: id.nullable(),
  artifactVersion: z.number().int().nonnegative().max(2_147_483_647),
  reviewable: z.boolean(),
  clarification: z
    .object({
      id,
      artifactId: id,
      artifactVersion,
      reviewRevision,
      question: z.string(),
      status: z.enum(["pending", "answered"]),
      executionExhausted: z.boolean(),
    })
    .nullable(),
});

export const answerSpecificationSchema = z
  .object({
    clarificationId: id,
    artifactId: id,
    artifactVersion,
    reviewRevision,
    requestId: id,
    answer: z
      .string()
      .trim()
      .min(1, "Enter an answer.")
      .refine((value) => Array.from(value).length <= 2000, "Use at most 2,000 characters."),
  })
  .strict();

export const specificationAnswerReceiptSchema = z.object({
  clarificationId: id,
  feedbackBatchId: id.nullable(),
  jobId: id.nullable(),
  runId: id.nullable(),
  executionExhausted: z.boolean(),
  replayed: z.boolean(),
});

export type SessionSpecificationState = z.infer<typeof sessionSpecificationStateSchema>;
export type SpecificationAnswerReceipt = z.infer<typeof specificationAnswerReceiptSchema>;
export type SpecificationAnswer = z.infer<typeof answerSpecificationSchema>;
