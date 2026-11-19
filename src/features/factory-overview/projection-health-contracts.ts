import { z } from "zod/v4";

const timestamp = z.iso.datetime({ offset: true }).nullable();
export const projectionActionSchema = z.enum(["pause", "resume", "rebuild"]);

export const projectionHealthSchema = z.object({
  status: z.enum(["ready", "building", "paused", "failed", "unavailable"]),
  canManage: z.boolean(),
  paused: z.boolean(),
  pausedAt: timestamp,
  oldestPendingAt: timestamp,
  lagSeconds: z.number().nonnegative().nullable(),
  lastAttemptAt: timestamp,
  lastSuccessAt: timestamp,
  sourceSnapshotAt: timestamp,
  failedAt: timestamp,
  retryAfter: timestamp,
  failedAttempts: z.number().int().nonnegative(),
  rebuild: z.object({
    state: z.enum(["idle", "queued", "building", "completed"]),
    requestedAt: timestamp,
    completedAt: timestamp,
  }),
  evaluatedAt: z.iso.datetime({ offset: true }),
});

export type ProjectionAction = z.infer<typeof projectionActionSchema>;
export type ProjectionHealth = z.infer<typeof projectionHealthSchema>;
