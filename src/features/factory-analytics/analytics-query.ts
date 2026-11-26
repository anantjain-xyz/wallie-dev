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

export const analyticsEnvironmentSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

const querySchema = z.object({
  factory: z
    .string()
    .uuid()
    .transform((id) => id.toLowerCase())
    .optional(),
  routingCanary: z.string().uuid().toLowerCase().optional(),
  routingAlert: z.string().uuid().toLowerCase().optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  compare: z.literal("previous").optional(),
  dimension: analyticsDimensionSchema.default("source"),
  environment: analyticsEnvironmentSchema.or(z.literal("")).optional(),
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
  routingCanaryId?: string;
  routingAlertId?: string;
};

export function recoverAnalyticsFilters(search: Record<string, string | string[] | undefined>) {
  const parsed = parseAnalyticsQuery(search);
  if (parsed.success) return { query: parsed.data, errors: {}, dates: undefined };

  const { factory, from, to, compare, dimension, environment, routingCanary, routingAlert } =
    search;
  const datesOnly = parseAnalyticsQuery({ from, to });
  const datesWithCompare = parseAnalyticsQuery({ from, to, compare });
  const fields = querySchema.shape;
  const safe = {
    factory: fields.factory.safeParse(factory),
    dimension: fields.dimension.safeParse(dimension),
    environment: fields.environment.safeParse(environment),
    routingCanary: fields.routingCanary.safeParse(routingCanary),
    routingAlert: fields.routingAlert.safeParse(routingAlert),
  };
  const clean = parseAnalyticsQuery({
    factory: safe.factory.success ? safe.factory.data : undefined,
    from: datesOnly.success ? from : undefined,
    to: datesOnly.success ? to : undefined,
    compare:
      datesWithCompare.success || (!datesOnly.success && compare === "previous")
        ? compare
        : undefined,
    dimension: safe.dimension.success ? safe.dimension.data : undefined,
    environment: safe.environment.success ? safe.environment.data : undefined,
    routingCanary: safe.routingCanary.success ? safe.routingCanary.data : undefined,
    routingAlert:
      safe.routingCanary.success && safe.routingCanary.data && safe.routingAlert.success
        ? safe.routingAlert.data
        : undefined,
  });
  if (!clean.success) throw new Error("Could not recover analytics filter controls.");

  const errors = {
    range: !datesOnly.success
      ? "Choose a UTC range of 1 to 366 days. The end must be later than the start."
      : undefined,
    compare:
      datesOnly.success && !datesWithCompare.success
        ? "The previous period is invalid for these dates. Adjust the range or leave comparison off."
        : undefined,
    dimension: !safe.dimension.success ? "Select a supported throughput breakdown." : undefined,
    environment: !safe.environment.success
      ? "Choose a deployment environment from the list."
      : undefined,
    other: undefined as string | undefined,
  };
  if (!Object.values(errors).some(Boolean))
    errors.other =
      "The saved evidence or factory filter is invalid. Apply these reporting filters to continue.";
  return {
    query: clean.data,
    errors,
    dates: !datesOnly.success
      ? {
          from: typeof from === "string" && fields.from.safeParse(from).success ? from : "",
          to: typeof to === "string" && fields.to.safeParse(to).success ? to : "",
        }
      : undefined,
  };
}

export type AnalyticsFilterErrors = ReturnType<typeof recoverAnalyticsFilters>["errors"];

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
    routingCanary,
    routingAlert,
  } = parsed.data;
  if (routingAlert && !routingCanary) return { success: false };
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
      ...(routingCanary ? { routingCanaryId: routingCanary } : {}),
      ...(routingAlert ? { routingAlertId: routingAlert } : {}),
    },
  };
}
