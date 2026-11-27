import {
  recoverAnalyticsFilters,
  parseAnalyticsQuery,
} from "@/features/factory-analytics/analytics-query";
import { workspaceAnalyticsPath } from "@/lib/routes";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceSlug: string }> },
) {
  const { workspaceSlug } = await params;
  const search = new URL(request.url).searchParams;
  function field(name: string) {
    const values = search.getAll(name);
    return values.length > 1 ? values : values[0];
  }
  const factory = parseAnalyticsQuery({ factory: field("factory") });
  const from = field("from");
  const to = field("to");
  const compare = field("compare");
  const dimension = field("dimension");
  const environment = field("environment");
  const { query, errors } = recoverAnalyticsFilters({
    from,
    to,
    compare,
    dimension,
    environment,
    routingCanary: field("routingCanary"),
    routingAlert: field("routingAlert"),
  });
  const invalid =
    Object.values(errors).some(Boolean) ||
    ["metric", "period", "facet", "bucket", "cursor"].some((key) => search.has(key));

  return new Response(null, {
    status: 307,
    headers: {
      "Cache-Control": "private, no-store",
      Location: workspaceAnalyticsPath(encodeURIComponent(workspaceSlug), {
        factory: factory.success ? (factory.data.factoryId ?? undefined) : "unavailable",
        from: typeof from === "string" && !errors.range ? from : undefined,
        to: typeof to === "string" && !errors.range ? to : undefined,
        compare: compare === "previous" && !errors.range && !errors.compare ? compare : undefined,
        dimension: typeof dimension === "string" && !errors.dimension ? query.dimension : undefined,
        environment: query.environment ?? undefined,
        routingCanary: query.routingCanaryId,
        routingAlert: query.routingAlertId,
        overviewFilters: invalid ? "invalid" : undefined,
      }),
    },
  });
}
