import { Suspense, type ReactNode } from "react";

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
import {
  analyticsCoreFields,
  analyticsEvidenceFields,
  analyticsFieldsHref,
} from "./analytics-navigation";
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
  scorerFields,
  periods,
  reportingHealth,
  details,
}: {
  workspaceId: string;
  workspaceSlug: string;
  factory: FactorySelectionOption;
  factorySelector?: ReactNode;
  query: AnalyticsQuery;
  scorerFields: Record<string, string | undefined>;
  periods: ReturnType<typeof loadAnalyticsPeriods>;
  reportingHealth: ReactNode;
  details: ReactNode;
}) {
  const action = workspaceAnalyticsPath(workspaceSlug);
  const retryHref = analyticsFieldsHref(action, {
    ...analyticsCoreFields(factory.id, query),
    ...analyticsEvidenceFields(query.evidence),
    ...scorerFields,
  });
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
        className="mb-5 sm:mb-6"
        description={factorySelector ? undefined : factory.name}
        title="Analytics"
      />
      <div className="space-y-5">
        <section aria-labelledby="overview-analytics" className="ui-sheet min-w-0">
          <div className="space-y-1 px-4 pt-3 pb-1 sm:px-5">
            <h2 className="type-section-title scroll-mt-4" id="overview-analytics" tabIndex={-1}>
              Factory outcomes
            </h2>
            <p className="type-secondary text-muted">{windowLabel(query)} (end excluded)</p>
          </div>
          <Suspense
            fallback={
              <p className="type-secondary px-4 py-3 text-muted sm:px-5">
                Loading factory outcomes…
              </p>
            }
          >
            <AnalyticsOutcomeBody periods={periods} retryHref={retryHref} />
          </Suspense>
          <div className="grid divide-y divide-border border-t border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <details className="min-w-0">
              <summary className={disclosureClass}>Reporting filters</summary>
              <AnalyticsReportingFilters
                action={action}
                factoryId={factory.id}
                query={query}
                scorerFields={scorerFields}
                mode="period"
              />
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
        {details}
      </div>
    </PageContainer>
  );
}

async function AnalyticsOutcomeBody({
  periods,
  retryHref,
}: {
  periods: ReturnType<typeof loadAnalyticsPeriods>;
  retryHref: string;
}) {
  const { primary, comparison } = await periods;
  const freshness = primary.flow.status === "ready" ? primary.flow.data.freshness : null;
  const snapshot = freshness?.status === "ready" ? freshness.sourceSnapshotAt : null;
  const delay = freshness && delayReasons[freshness.status];
  return (
    <>
      {(snapshot || delay) && (
        <div className="type-label flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 pb-3 text-muted sm:px-5">
          {snapshot ? (
            <>
              <Status compact label="Flow and delivery current" value="healthy" />
              <time dateTime={snapshot}>Snapshot {timeLabel(snapshot)}</time>
            </>
          ) : (
            <>
              <Status compact label="Flow and delivery delayed" value="needs_attention" />
              <span>{delay}. Sessions and outcome capture continue.</span>
            </>
          )}
        </div>
      )}
      <AnalyticsHighlights comparison={comparison} period={primary} retryHref={retryHref} />
    </>
  );
}

export function AnalyticsDetailsView({
  workspaceSlug,
  factoryId,
  query,
  environments,
  labels,
  scorerFields,
  periods,
  evidence,
  routingCanaryComparison,
  scorerTrends,
  noScorerCohorts,
}: {
  workspaceSlug: string;
  factoryId: string;
  query: AnalyticsQuery;
  environments: string[] | null;
  labels: AnalyticsLabels;
  scorerFields: Record<string, string | undefined>;
  periods: Awaited<ReturnType<typeof loadAnalyticsPeriods>>;
  evidence: Awaited<ReturnType<typeof loadAnalyticsEvidence>>;
  routingCanaryComparison: ReactNode;
  scorerTrends: ReactNode;
  noScorerCohorts: boolean;
}) {
  const action = workspaceAnalyticsPath(workspaceSlug);
  const filterProps = { action, environments, factoryId, query, scorerFields };
  const href: AnalyticsHref = (selection) =>
    analyticsCohortHref(workspaceSlug, factoryId, query, selection, scorerFields);
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

  return (
    <>
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
        noScorerCohorts={noScorerCohorts}
      />
      {scorerTrends}
      {routingCanaryComparison}
    </>
  );
}
