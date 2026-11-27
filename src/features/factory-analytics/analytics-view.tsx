import type { ReactNode } from "react";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { Status } from "@/components/ui/status";
import type {
  loadAnalyticsEvidence,
  loadAnalyticsPeriods,
} from "@/features/factory-analytics/analytics-data";
import { AnalyticsEvidence } from "@/features/factory-analytics/analytics-view-evidence";
import { type AnalyticsExportFilters } from "@/features/factory-analytics/analytics-export-contracts";
import { AnalyticsExportControls } from "@/features/factory-analytics/analytics-export-controls";
import {
  AnalyticsHighlights,
  AnalyticsMetrics,
} from "@/features/factory-analytics/analytics-view-metrics";
import { type AnalyticsLabels, throughputLabel } from "./analytics-labels";
import type { AnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import { AnalyticsReportingFilters } from "@/features/factory-analytics/analytics-reporting-filters";
import {
  type AnalyticsHref,
  analyticsCohortHref,
  timeLabel,
  windowLabel,
} from "@/features/factory-analytics/analytics-view-shared";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { workspaceAnalyticsPath } from "@/lib/routes";

const disclosureClass =
  "type-secondary cursor-pointer rounded-sm px-4 py-3 font-medium marker:text-muted hover:bg-control-muted hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-5";
const reportLinkClass =
  "type-secondary rounded-sm underline underline-offset-4 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const delayReasons = {
  ready: null,
  unavailable: null,
  building: "Projection updating",
  paused: "Projection paused",
  failed: "Projection update failed",
} as const;

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
  reportingHealth,
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
  reportingHealth: ReactNode;
  routingCanaryComparison?: ReactNode;
  scorerTrends?: ReactNode;
}) {
  const action = workspaceAnalyticsPath(workspaceSlug);
  const filterProps = { action, environments, factoryId: factory.id, query, scorerFields };
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
  const flow = periods.primary.flow;
  const freshness = flow.status === "ready" ? flow.data.freshness : null;
  const snapshot = freshness?.status === "ready" ? freshness.sourceSnapshotAt : null;
  const delay = freshness && delayReasons[freshness.status];

  return (
    <PageContainer>
      <PageHeader
        actions={factorySelector}
        className="mb-5 sm:mb-6"
        description={factorySelector ? undefined : factory.name}
        title="Analytics"
      />
      <div className="space-y-5">
        <section aria-labelledby="overview-analytics" className="ui-sheet min-w-0">
          <div className="space-y-1 border-b border-border px-4 py-3 sm:px-5">
            <h2 className="type-section-title scroll-mt-4" id="overview-analytics" tabIndex={-1}>
              Factory outcomes
            </h2>
            <p className="type-secondary text-muted">{windowLabel(query)} (end excluded)</p>
            <div className="type-label flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
              {snapshot ? (
                <>
                  <Status compact label="Flow and delivery current" value="healthy" />
                  <time dateTime={snapshot}>Snapshot {timeLabel(snapshot)}</time>
                </>
              ) : delay ? (
                <>
                  <Status compact label="Flow and delivery delayed" value="needs_attention" />
                  <span>{delay}. Sessions and outcome capture continue.</span>
                </>
              ) : (
                <Status
                  compact
                  label="Flow and delivery freshness unavailable"
                  value="not_started"
                />
              )}
            </div>
          </div>
          <AnalyticsHighlights period={periods.primary} />
          <div className="grid divide-y divide-border border-t border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <details className="min-w-0">
              <summary className={disclosureClass}>Reporting filters</summary>
              <AnalyticsReportingFilters {...filterProps} mode="period" />
            </details>
            <AnalyticsExportControls
              factoryId={factory.id}
              filters={exportFilters}
              key={JSON.stringify([workspaceId, factory.id, exportFilters])}
              workspaceId={workspaceId}
            />
          </div>
        </section>
        <section
          aria-label="Reporting health"
          className="ui-sheet min-w-0 scroll-mt-4"
          id="reporting-health"
          tabIndex={-1}
        >
          {reportingHealth}
        </section>
        {(scorerTrends || routingCanaryComparison) && (
          <nav className="flex flex-wrap gap-x-4 gap-y-2" aria-label="Additional reports">
            {scorerTrends && (
              <a className={reportLinkClass} href="#scorer-trends">
                Scorer trends
              </a>
            )}
            {routingCanaryComparison && (
              <a className={reportLinkClass} href="#routing-canary">
                Routing canary
              </a>
            )}
          </nav>
        )}

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
          environmentFilter={<AnalyticsReportingFilters {...filterProps} mode="environment" />}
          dimensionFilter={<AnalyticsReportingFilters {...filterProps} mode="dimension" />}
        />
        {scorerTrends}
        {routingCanaryComparison}
      </div>
    </PageContainer>
  );
}
