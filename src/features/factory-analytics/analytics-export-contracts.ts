import { z } from "zod";

import { analyticsDimensionSchema, parseAnalyticsQuery } from "./analytics-query";

export const analyticsExportReceiptSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
});

export const analyticsExportFormatSchema = z.enum(["csv", "json"]);

export type AnalyticsExportReceipt = z.infer<typeof analyticsExportReceiptSchema>;
export type AnalyticsExportFormat = z.infer<typeof analyticsExportFormatSchema>;

const requestSchema = z.strictObject({
  requestId: z.string().uuid(),
  from: z.string(),
  to: z.string(),
  compare: z.literal("previous").optional(),
  dimension: analyticsDimensionSchema.optional(),
  environment: z.string().optional(),
});
export type AnalyticsExportFilters = Omit<z.infer<typeof requestSchema>, "requestId">;

export function parseAnalyticsExportRequest(input: unknown) {
  const body = requestSchema.safeParse(input);
  if (!body.success) return null;
  const { requestId, ...filters } = body.data;
  const parsed = parseAnalyticsQuery(filters);
  return parsed.success ? { requestId, query: parsed.data } : null;
}

export function factoryAnalyticsExportsPath(workspaceId: string, factoryId: string) {
  return [
    "/api/workspaces",
    encodeURIComponent(workspaceId),
    "factories",
    encodeURIComponent(factoryId),
    "analytics-exports",
  ].join("/");
}
