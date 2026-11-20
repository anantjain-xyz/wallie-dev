import { z } from "zod";

import { scoreSnapshotSchema, scoreTrendStatusSchema } from "./score-trend-contracts";

const dayMs = 86_400_000;
const date = z.string().date();
const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const format = z.object({
  from: date.optional(),
  to: date.optional(),
  cohort: id.optional(),
  scorerRevision: id.optional(),
  evaluationDay: date.optional(),
  evaluationStatus: scoreTrendStatusSchema.or(z.literal("").transform(() => undefined)).optional(),
  scoreSnapshot: scoreSnapshotSchema.optional(),
  beforeRunFinishedAt: z.string().datetime({ offset: true }).optional(),
  beforeScoreRun: id.optional(),
});

export type ScorerTrendQuery = z.output<typeof format> & { from: string; to: string };

export function parseScorerTrendQuery(
  search: Record<string, string | string[] | undefined>,
  defaults?: { from: string; to: string },
  now = new Date(),
): ScorerTrendQuery | null {
  const parsed = format.safeParse(search);
  if (!parsed.success) return null;
  const { from, to, ...filters } = parsed.data;
  if ((from === undefined) !== (to === undefined)) return null;
  if ((filters.beforeRunFinishedAt === undefined) !== (filters.beforeScoreRun === undefined))
    return null;
  if (
    (filters.scoreSnapshot && !filters.cohort) ||
    (filters.beforeScoreRun && !filters.scoreSnapshot)
  )
    return null;
  const tomorrow = (Math.floor(now.getTime() / dayMs) + 1) * dayMs;
  const start =
    from ?? defaults?.from ?? new Date(tomorrow - dayMs * 30).toISOString().slice(0, 10);
  const end = to ?? defaults?.to ?? new Date(tomorrow).toISOString().slice(0, 10);
  const range = Date.parse(end) - Date.parse(start);
  if (start < "0001-01-01" || !(range >= dayMs && range <= dayMs * 366)) return null;
  if (filters.evaluationDay && (filters.evaluationDay < start || filters.evaluationDay >= end)) {
    return null;
  }
  return { from: start, to: end, ...filters };
}
