import { z } from "zod";

export const MAX_BENCHMARK_SCORER_REVISIONS = 16;
export const MAX_BENCHMARK_EVALUATION_BUDGET_USD = 1_000_000;
export const BENCHMARK_EVALUATION_BUDGET_STEP_USD = 0.000001;

export const benchmarkEvaluationPlanSchema = z.strictObject({
  scorerRevisionIds: z
    .array(
      z
        .string()
        .uuid()
        .transform((value) => value.toLowerCase()),
    )
    .min(1, "Select at least one scorer revision.")
    .max(MAX_BENCHMARK_SCORER_REVISIONS)
    .refine((ids) => new Set(ids).size === ids.length, "Select each scorer revision once.")
    .transform((ids) => ids.sort()),
  budgetLimitUsd: z
    .number()
    .min(0)
    .max(MAX_BENCHMARK_EVALUATION_BUDGET_USD)
    .multipleOf(BENCHMARK_EVALUATION_BUDGET_STEP_USD),
});

type BenchmarkEvaluationPlan = z.infer<typeof benchmarkEvaluationPlanSchema>;

export function matchesBenchmarkEvaluationPlan(
  stored: BenchmarkEvaluationPlan | undefined,
  requested: BenchmarkEvaluationPlan | undefined,
) {
  if (!stored || !requested) return stored === requested;
  return (
    stored.budgetLimitUsd === requested.budgetLimitUsd &&
    stored.scorerRevisionIds.length === requested.scorerRevisionIds.length &&
    stored.scorerRevisionIds.every((id, index) => id === requested.scorerRevisionIds[index])
  );
}
