import type { ReactNode } from "react";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import type {
  loadAnalyticsEvidence,
  loadAnalyticsPeriods,
} from "@/features/factory-analytics/analytics-data";
import { AnalyticsEvidence } from "@/features/factory-analytics/analytics-view-evidence";
import { type AnalyticsExportFilters } from "@/features/factory-analytics/analytics-export-contracts";
import { AnalyticsExportControls } from "@/features/factory-analytics/analytics-export-controls";
import { AnalyticsMetrics } from "@/features/factory-analytics/analytics-view-metrics";
import { type AnalyticsLabels, throughputLabel } from "./analytics-labels";
import type { AnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import { AnalyticsReportingFilters } from "@/features/factory-analytics/analytics-reporting-filters";
import {
  type AnalyticsHref,
  analyticsCohortHref,
} from "@/features/factory-analytics/analytics-view-shared";
import {
  analyticsCoreFields,
  analyticsEvidenceFields,
  analyticsFieldsHref,
} from "./analytics-navigation";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { workspaceAnalyticsPath } from "@/lib/routes";

export function AnalyticsView({
  workspaceId,
  workspaceSlug,
  factory,
  factorySelector,
  query,
  environments,
  labels,
  scorerFields,
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
  environments: string[] | null;
  labels: AnalyticsLabels;
  scorerFields: Record<string, string | undefined>;
  periods: Awaited<ReturnType<typeof loadAnalyticsPeriods>>;
  evidence: Awaited<ReturnType<typeof loadAnalyticsEvidence>>;
  routingCanaryComparison?: ReactNode;
  scorerTrends?: ReactNode;
}) {
  const href: AnalyticsHref = (selection) =>
    analyticsCohortHref(workspaceSlug, factory.id, query, selection, scorerFields);

  const bucket = query.evidence?.metric === "throughput" ? query.evidence.bucket : null;
  const recordedBucketLabel = bucket
    ? [periods.primary, periods.comparison]
        .flatMap((period) =>
          period?.throughput.status === "ready" ? period.throughput.data.buckets : [],
        )
        .find(({ key }) => key === bucket)?.label
    : undefined;
  const bucketLabel =
    bucket && recordedBucketLabel
      ? throughputLabel(labels.buckets, query.dimension, bucket, recordedBucketLabel)
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
      <AnalyticsReportingFilters
        action={workspaceAnalyticsPath(workspaceSlug)}
        environments={environments}
        factoryId={factory.id}
        query={query}
        scorerFields={scorerFields}
      />
      <AnalyticsExportControls
        factoryId={factory.id}
        filters={exportFilters}
        key={JSON.stringify([workspaceId, factory.id, exportFilters])}
        workspaceId={workspaceId}
      />
      {routingCanaryComparison ? <div className="mb-8">{routingCanaryComparison}</div> : null}

      {query.evidence && (
        <AnalyticsEvidence
          bucketLabel={bucketLabel}
          query={query}
          evidence={evidence}
          href={href}
          labels={labels}
          workspaceSlug={workspaceSlug}
        />
      )}
      <AnalyticsMetrics
        query={query}
        periods={periods}
        href={href}
        bucketLabels={labels.buckets}
        clearEnvironmentHref={
          analyticsFieldsHref(workspaceAnalyticsPath(workspaceSlug), {
            ...analyticsCoreFields(factory.id, query),
            ...analyticsEvidenceFields(query.evidence),
            ...scorerFields,
            cursor: undefined,
            environment: undefined,
          }) + "#analytics-filters"
        }
      />
      {scorerTrends ? <div className="mt-8">{scorerTrends}</div> : null}
    </PageContainer>
  );
}
