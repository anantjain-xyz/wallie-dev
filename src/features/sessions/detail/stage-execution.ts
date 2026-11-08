import { z } from "zod";

import type { WallieRun } from "@/features/wallie/types";

/** Minimal execution identity shared by the initial page, recovery, and live history. */
export type StageExecution = Pick<
  WallieRun,
  "id" | "stageId" | "status" | "createdAt" | "updatedAt"
>;

const stageExecutionSchema = z.object({
  id: z.string(),
  stageId: z.string().nullable(),
  status: z.enum(["queued", "started", "running", "success", "error", "canceled"]),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export function parseStageExecution(value: unknown): StageExecution | null {
  const parsed = stageExecutionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A delayed history load or recovery response must not resurrect an older attempt. */
export function newerStageExecution(
  current: StageExecution | null,
  incoming: StageExecution | null,
): StageExecution | null {
  if (!current) return incoming;
  if (!incoming) return current;
  const created = Date.parse(incoming.createdAt) - Date.parse(current.createdAt);
  if (created !== 0) return created > 0 ? incoming : current;
  const updated = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  if (updated !== 0) return updated > 0 ? incoming : current;
  const rank = { queued: 0, started: 1, running: 2, success: 3, error: 3, canceled: 3 };
  return rank[incoming.status] > rank[current.status] ? incoming : current;
}
