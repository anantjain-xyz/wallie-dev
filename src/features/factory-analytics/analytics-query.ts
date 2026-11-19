import { z } from "zod";

export { resolveAnalyticsFactory } from "@/features/factories/factory-selection";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

export const analyticsFlowPhaseSchema = z.enum([
  "queued",
  "active",
  "blocked",
  "review",
  "delivery",
  "unknown",
]);
export const analyticsDeliveryStatusSchema = z.enum(["measured", "censored", "unknown"]);
export const analyticsCostFacetSchema = z.enum([
  "measured",
  "estimated",
  "pending",
  "unavailable",
  "known",
  "unresolved",
  "unlinked",
]);
export const analyticsRevertStatusSchema = z.enum(["covered", "immature", "partial", "ambiguous"]);
const revertFacetSchema = analyticsRevertStatusSchema.or(z.enum(["verified", "covered-verified"]));
export const analyticsDimensionSchema = z.enum([
  "source",
  "person",
  "agent",
  "model",
  "harness",
  "definition",
]);

const evidenceMetricSchema = z.enum([
  "flow",
  "merge",
  "deployment",
  "delivery-cost",
  "operating-cost",
  "cost-merges",
  "throughput",
  "revert",
]);
const periodSchema = z.enum(["primary", "compare"]);
const evidenceBase = {
  period: periodSchema,
  cursor: z
    .string()
    .max(768)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
};
const evidenceSelectionSchema = z.discriminatedUnion("metric", [
  z.strictObject({
    ...evidenceBase,
    metric: z.literal("flow"),
    facet: analyticsFlowPhaseSchema.optional(),
  }),
  z.strictObject({
    ...evidenceBase,
    metric: z.enum(["merge", "deployment"]),
    facet: analyticsDeliveryStatusSchema.optional(),
  }),
  z.strictObject({
    ...evidenceBase,
    metric: z.enum(["delivery-cost", "operating-cost"]),
    facet: analyticsCostFacetSchema.optional(),
  }),
  z.strictObject({ ...evidenceBase, metric: z.literal("cost-merges") }),
  z.strictObject({
    ...evidenceBase,
    metric: z.literal("throughput"),
    bucket: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^\p{Cc}]+$/u)
      .optional(),
  }),
  z.strictObject({
    ...evidenceBase,
    metric: z.literal("revert"),
    facet: revertFacetSchema.optional(),
  }),
]);

const querySchema = z.object({
  factory: z
    .string()
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  compare: z.literal("previous").optional(),
  dimension: analyticsDimensionSchema.default("source"),
  environment: z.union([z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/), z.literal("")]).optional(),
  metric: evidenceMetricSchema.optional(),
  period: periodSchema.optional(),
  facet: z.string().max(32).optional(),
  bucket: z.string().max(512).optional(),
  cursor: evidenceBase.cursor,
});

export type AnalyticsWindow = { from: string; to: string };
export type AnalyticsEvidenceSelection = z.infer<typeof evidenceSelectionSchema>;
export type AnalyticsQuery = AnalyticsWindow & {
  factoryId: string | null;
  dimension: z.infer<typeof analyticsDimensionSchema>;
  environment: string | null;
  comparison: AnalyticsWindow | null;
  evidence: AnalyticsEvidenceSelection | null;
};

function analyticsWindow(from: number, to: number): AnalyticsWindow {
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function parseAnalyticsQuery(
  searchParams: Record<string, string | string[] | undefined>,
  now = new Date(),
): { success: true; data: AnalyticsQuery } | { success: false } {
  const parsed = querySchema.safeParse(searchParams);
  if (!parsed.success) return { success: false };

  const {
    factory,
    from,
    to,
    compare,
    dimension,
    environment,
    metric,
    period,
    facet,
    bucket,
    cursor,
  } = parsed.data;
  if ((from === undefined) !== (to === undefined)) return { success: false };
  const end = to ? Date.parse(to) : Math.floor(now.getTime() / DAY_MS) * DAY_MS;
  const start = from ? Date.parse(from) : end - DEFAULT_DAYS * DAY_MS;
  const duration = end - start;
  if (!(duration > 0 && duration <= MAX_DAYS * DAY_MS)) return { success: false };

  const earliest = Date.parse("0001-01-01");
  if (start < earliest || (compare && start - duration < earliest)) return { success: false };
  const comparison = compare ? analyticsWindow(start - duration, start) : null;

  let evidence: AnalyticsEvidenceSelection | null = null;
  if (metric) {
    const selection = evidenceSelectionSchema.safeParse({
      metric,
      period: period ?? "primary",
      cursor,
      ...(facet === undefined ? {} : { facet }),
      ...(bucket === undefined ? {} : { bucket }),
    });
    if (!selection.success || (selection.data.period === "compare" && !comparison))
      return { success: false };
    evidence = selection.data;
  } else if (period || facet !== undefined || bucket !== undefined || cursor) {
    return { success: false };
  }

  return {
    success: true,
    data: {
      ...analyticsWindow(start, end),
      factoryId: factory ?? null,
      dimension,
      environment: environment || null,
      comparison,
      evidence,
    },
  };
}
