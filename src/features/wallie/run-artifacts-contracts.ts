import { z } from "zod";

export const runArtifactKindSchema = z.enum([
  "checkpoint",
  "stage_markdown",
  "validation_log",
  "validation_preview",
  "validation_report",
  "validation_screenshot",
]);

export const runArtifactAvailabilitySchema = z.enum([
  "available",
  "recorded",
  "retained",
  "missing",
  "expired",
  "redacted",
  "inaccessible",
  "integrity_mismatch",
  "unavailable",
]);

export type RunArtifactKind = z.infer<typeof runArtifactKindSchema>;
export type RunArtifactAvailability = z.infer<typeof runArtifactAvailabilitySchema>;

export const runArtifactScopeSchema = z.object({
  workspaceId: z.string().uuid(),
  runId: z.string().uuid(),
});
export const runArtifactItemParamsSchema = runArtifactScopeSchema.extend({
  kind: runArtifactKindSchema,
  artifactId: z.string().uuid(),
});

export const runArtifactListQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(512)
      .optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .pipe(z.number().int().max(50))
      .optional(),
  })
  .strict();

export const runArtifactItemQuerySchema = z
  .object({ download: z.literal("1").optional() })
  .strict();

export const runArtifactCursorSchema = runArtifactItemParamsSchema.extend({
  version: z.literal(1),
});
