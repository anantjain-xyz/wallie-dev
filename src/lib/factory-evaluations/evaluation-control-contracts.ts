import { z } from "zod";

const revision = z.number().int().min(0).max(2_147_483_647);
const maxConcurrent = z.number().int().min(1).max(16);
const timestamp = z.string().datetime({ offset: true });

export const configureFactoryEvaluationLaneSchema = z
  .object({ expectedRevision: revision, paused: z.boolean(), maxConcurrent })
  .strict();

export const factoryEvaluationLaneSchema = z
  .object({ revision, paused: z.boolean(), maxConcurrent, updatedAt: timestamp.nullable() })
  .strict();

export const terminalFactoryEvaluationSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["succeeded", "failed", "canceled"]),
    finishedAt: timestamp,
  })
  .strict();
