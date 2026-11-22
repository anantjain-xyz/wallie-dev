import type { ReactNode } from "react";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import type {
  loadAnalyticsEvidence,
  loadAnalyticsPeriods,
} from "@/features/factory-analytics/analytics-data";
import { AnalyticsFilters } from "@/features/factory-analytics/analytics-filters";
import { AnalyticsEvidence } from "@/features/factory-analytics/analytics-view-evidence";
import { type AnalyticsExportFilters } from "@/features/factory-analytics/analytics-export-contracts";
import { AnalyticsExportControls } from "@/features/factory-analytics/analytics-export-controls";
import { AnalyticsMetrics } from "@/features/factory-analytics/analytics-view-metrics";
import type { AnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import {
  type AnalyticsHref,
  analyticsCohortHref,
} from "@/features/factory-analytics/analytics-view-shared";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { workspaceAnalyticsPath } from "@/lib/routes";

export function AnalyticsView({
  workspaceId,
  workspaceSlug,
  factory,
  factorySelector,
  query,
  periods,
  evidence,
  routingCanaryComparison,
  scorerTrends,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factory: FactorySelectionOption;
  factorySelector?: ReactNode;
  query: AnalyticsQuery;
  periods: Awaited<ReturnType<typeof loadAnalyticsPeriods>>;
  evidence: Awaited<ReturnType<typeof loadAnalyticsEvidence>>;
  routingCanaryComparison?: ReactNode;
  scorerTrends?: ReactNode;
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
  const exportFilters: AnalyticsExportFilters = {
    from: query.from.slice(0, 10),
    to: query.to.slice(0, 10),
    compare: query.comparison ? "previous" : undefined,
    dimension: query.dimension,
    environment: query.environment ?? undefined,
  };

  return (
    <PageContainer>
      <PageHeader
        actions={factorySelector}
        actionsRightOnDesktop
        description={factorySelector ? undefined : factory.name}
        title="Analytics"
      />
      {routingCanaryComparison ? <div className="mb-8">{routingCanaryComparison}</div> : null}
      <AnalyticsFilters
        action={workspaceAnalyticsPath(workspaceSlug)}
        factoryId={factory.id}
        query={query}
      />
      <AnalyticsExportControls
        factoryId={factory.id}
        filters={exportFilters}
        key={JSON.stringify([workspaceId, factory.id, exportFilters])}
        workspaceId={workspaceId}
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
      {scorerTrends ? <div className="mt-8">{scorerTrends}</div> : null}
    </PageContainer>
  );
}
