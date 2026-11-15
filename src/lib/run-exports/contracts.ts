import { z } from "zod";

export const MAX_RUN_RETENTION_DAYS = 3650;

const retentionDays = z.number().int().min(1).max(MAX_RUN_RETENTION_DAYS).nullable();
export const runRetentionSchema = z
  .object({
    transcriptDays: retentionDays,
    evidenceDays: retentionDays,
  })
  .strict();

export const runRetentionResponseSchema = z.object({ retention: runRetentionSchema });

export type RunRetention = z.infer<typeof runRetentionSchema>;

export const runExportRequestSchema = z.object({ requestId: z.string().uuid() }).strict();

export const runExportSummarySchema = z.object({
  id: z.string().uuid(),
  requestedAt: z.string().datetime({ offset: true }),
  snapshotAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }),
  status: z.enum(["queued", "running", "completed", "failed", "expired"]),
  itemCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
});

export const runExportListResponseSchema = z.object({
  exports: z.array(runExportSummarySchema),
});

export const runExportResponseSchema = z.object({ export: runExportSummarySchema });

export type RunExportSummary = z.infer<typeof runExportSummarySchema>;
