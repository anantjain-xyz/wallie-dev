import { z } from "zod";

const count = z.number().int().nonnegative();

export const maintenanceTickResponseSchema = z.object({
  cleanup: z
    .object({
      stalledRunIds: z.array(z.string()),
      retriedJobIds: z.array(z.string()),
      terminalErroredJobIds: z.array(z.string()),
      stoppedSandboxIds: z.array(z.string()),
      incomplete: z.literal(true).optional(),
    })
    .nullable(),
  reconciliation: z
    .object({
      canceled: count,
      checked: count,
      rateLimited: z.boolean(),
      incomplete: z.literal(true).optional(),
      skipped: z.literal(true).optional(),
    })
    .nullable(),
  githubVerification: z
    .object({
      checked: count,
      refreshed: count,
      failed: count,
      limited: z.literal(true).optional(),
    })
    .nullable(),
});

export type MaintenanceTickResponse = z.infer<typeof maintenanceTickResponseSchema>;
