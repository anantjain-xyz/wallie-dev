import { z } from "zod";

const id = z.string().uuid();
const purpose = z.enum(["regression", "holdout"]);
const eligibilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("eligible"), reasons: z.tuple([]) }),
  z.object({ status: z.literal("ineligible"), reasons: z.array(z.string()).min(1) }),
]);

export const benchmarkCapturePreviewSchema = z.object({
  source: z.object({
    runId: id,
    sessionId: id,
    name: z.string(),
    originalPrompt: z.string().nullable(),
    checkoutSha: z.string().nullable(),
    inputRef: z.string().nullable(),
    definitionRevisionId: id.nullable(),
    contextManifestSha: z.string().nullable(),
    recordedPromptSha: z.string().nullable(),
    eligibility: eligibilitySchema,
  }),
  suites: z.array(z.object({ id, revisionId: id, name: z.string(), purpose })),
  existingTask: z.object({ id, revisionId: id, acceptanceCriteria: z.string() }).nullable(),
});

export const benchmarkCaptureRequestSchema = z
  .object({
    acceptanceCriteria: z.string().trim().min(1).max(20_000).optional(),
    expectedTaskRevisionId: id.optional(),
    suite: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("existing"), id, revisionId: id }).strict(),
      z
        .object({ kind: z.literal("new"), id, name: z.string().trim().min(1).max(120), purpose })
        .strict(),
    ]),
  })
  .strict();

export const benchmarkCaptureResultSchema = z.object({
  taskId: id,
  taskRevisionId: id,
  suiteId: id,
  suiteRevisionId: id,
  added: z.boolean(),
});

export type BenchmarkCapturePreview = z.infer<typeof benchmarkCapturePreviewSchema>;
export type BenchmarkCaptureRequest = z.infer<typeof benchmarkCaptureRequestSchema>;
export type BenchmarkCaptureResult = z.infer<typeof benchmarkCaptureResultSchema>;
