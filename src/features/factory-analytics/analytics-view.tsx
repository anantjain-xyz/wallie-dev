import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import type {
  loadAnalyticsEvidence,
  loadAnalyticsPeriods,
} from "@/features/factory-analytics/analytics-data";
import { AnalyticsFilters } from "@/features/factory-analytics/analytics-filters";
import { AnalyticsEvidence } from "@/features/factory-analytics/analytics-view-evidence";
import { AnalyticsMetrics } from "@/features/factory-analytics/analytics-view-metrics";
import type { AnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import {
  type AnalyticsHref,
  analyticsCohortHref,
} from "@/features/factory-analytics/analytics-view-shared";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { workspaceAnalyticsPath } from "@/lib/routes";

export function AnalyticsView({
  workspaceSlug,
  factory,
  query,
  periods,
  evidence,
}: {
  workspaceSlug: string;
  factory: FactorySelectionOption;
  query: AnalyticsQuery;
  periods: Awaited<ReturnType<typeof loadAnalyticsPeriods>>;
  evidence: Awaited<ReturnType<typeof loadAnalyticsEvidence>>;
}) {
  const href: AnalyticsHref = (selection) =>
    analyticsCohortHref(workspaceSlug, factory.id, query, selection);

  const bucket = query.evidence?.metric === "throughput" ? query.evidence.bucket : null;
  const bucketLabel = bucket
    ? [periods.primary, periods.comparison]
        .flatMap((period) =>
          period?.throughput.status === "ready" ? period.throughput.data.buckets : [],
        )
        .find(({ key }) => key === bucket)?.label
    : undefined;

  return (
    <PageContainer>
      <PageHeader title="Analytics" description={factory.name} />
      <AnalyticsFilters
        action={workspaceAnalyticsPath(workspaceSlug)}
        factoryId={factory.id}
        query={query}
      />

      {query.evidence && (
        <AnalyticsEvidence
          bucketLabel={bucketLabel}
          query={query}
          evidence={evidence}
          href={href}
          workspaceSlug={workspaceSlug}
        />
      )}
      <AnalyticsMetrics query={query} periods={periods} href={href} />
    </PageContainer>
  );
}
