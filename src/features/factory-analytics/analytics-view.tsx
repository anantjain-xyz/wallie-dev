import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import type {
  loadAnalyticsEvidence,
  loadAnalyticsPeriods,
} from "@/features/factory-analytics/analytics-data";
import { AnalyticsEvidence } from "@/features/factory-analytics/analytics-view-evidence";
import { AnalyticsMetrics } from "@/features/factory-analytics/analytics-view-metrics";
import type { AnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import {
  type AnalyticsHref,
  dimensionLabels,
  windowLabel,
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
  const href: AnalyticsHref = (selection) => {
    const url = workspaceAnalyticsPath(workspaceSlug, {
      factory: factory.id,
      from: query.from.slice(0, 10),
      to: query.to.slice(0, 10),
      compare: query.comparison ? "previous" : undefined,
      dimension: query.dimension,
      environment: query.environment ?? undefined,
      ...selection,
    });
    return selection ? `${url}#analytics-evidence` : url;
  };

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
      <form
        action={workspaceAnalyticsPath(workspaceSlug)}
        className="ui-sheet mb-6 flex flex-wrap items-end gap-4 p-4"
        method="get"
      >
        <input name="factory" type="hidden" value={factory.id} />
        <label className="type-label flex flex-col gap-1.5">
          From date
          <input
            className="ui-input"
            defaultValue={query.from.slice(0, 10)}
            name="from"
            required
            type="date"
          />
        </label>
        <label className="type-label flex flex-col gap-1.5">
          To date
          <input
            className="ui-input"
            defaultValue={query.to.slice(0, 10)}
            name="to"
            required
            type="date"
          />
        </label>
        <label className="type-label flex flex-col gap-1.5">
          Break down throughput by
          <select className="ui-input" defaultValue={query.dimension} name="dimension">
            {Object.entries(dimensionLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="type-label flex flex-col gap-1.5">
          Deployment environment
          <input
            className="ui-input"
            defaultValue={query.environment ?? ""}
            maxLength={64}
            name="environment"
            placeholder="All environments"
          />
        </label>
        <label className="type-label flex h-9 items-center gap-2">
          <input
            defaultChecked={query.comparison !== null}
            name="compare"
            type="checkbox"
            value="previous"
          />
          Compare with previous period
        </label>
        <button className="ui-button-primary h-9 px-3 text-sm" type="submit">
          Apply filters
        </button>
      </form>
      <p className="type-secondary mb-8 text-muted">
        {windowLabel(query)}. Dates include the start and exclude the end.
        {query.comparison ? ` Previous period ${windowLabel(query.comparison)}.` : ""}
      </p>

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
