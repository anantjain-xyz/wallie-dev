import type { ReactNode } from "react";

import type { AnalyticsPeriodData } from "@/features/factory-analytics/analytics-data";
import {
  analyticsCostFacetSchema,
  analyticsFlowPhaseSchema,
  type AnalyticsQuery,
} from "@/features/factory-analytics/analytics-query";
import {
  type AnalyticsHref,
  dimensionLabels,
  durationLabel,
  type EvidenceLink,
  MetricPanel,
  type MetricGroup,
  type MetricPoint,
  type MetricRow,
  moneyFormat,
  numberFormat,
  periodLabels,
  timeLabel,
} from "@/features/factory-analytics/analytics-view-shared";

type Periods = { primary: AnalyticsPeriodData; comparison: AnalyticsPeriodData | null };
type MetricViewProps = { periods: Periods; href: AnalyticsHref };

function ready<T>(result: { status: "ready"; data: T } | { status: "unavailable" }) {
  return result.status === "ready" ? result.data : null;
}

function measuredPoint(
  value: number | null,
  evidence: EvidenceLink,
  format: (number: number) => string = (number) => numberFormat.format(number),
  missing = "Unavailable",
): MetricPoint {
  return { value, label: value === null ? missing : format(value), evidence };
}

function comparedRow(
  key: string,
  label: string,
  periods: Periods,
  point: (period: AnalyticsPeriodData) => MetricPoint,
  actionLabel?: string,
): MetricRow {
  return {
    key,
    label,
    actionLabel,
    primary: point(periods.primary),
    ...(periods.comparison ? { comparison: point(periods.comparison) } : {}),
  };
}

function PeriodNotes({
  periods,
  describe,
}: {
  periods: Periods;
  describe: (period: AnalyticsPeriodData) => ReactNode;
}) {
  return (
    <dl className="type-label space-y-1.5 border-t border-border pt-2 text-muted">
      <div>
        <dt className="inline font-medium text-foreground">{periodLabels.primary} </dt>
        <dd className="inline">{describe(periods.primary)}</dd>
      </div>
      {periods.comparison && (
        <div>
          <dt className="inline font-medium text-foreground">{periodLabels.compare} </dt>
          <dd className="inline">{describe(periods.comparison)}</dd>
        </div>
      )}
    </dl>
  );
}

const phaseLabels = {
  queued: "Queued",
  active: "Active",
  blocked: "Blocked",
  review: "Review",
  delivery: "Delivery",
  unknown: "Unknown phase",
} satisfies Record<(typeof analyticsFlowPhaseSchema.options)[number], string>;

function flowFreshness(freshness: NonNullable<ReturnType<typeof flowSummary>>["freshness"]) {
  const status =
    {
      building: "Updating · snapshot may be stale",
      failed: "Update failed · snapshot may be stale",
      paused: "Paused · snapshot may be stale",
      unavailable: "No projection snapshot",
      ready: "Current snapshot",
    }[freshness.status] ?? freshness.status;
  return `${status}. Source snapshot ${timeLabel(freshness.sourceSnapshotAt)}. Last successful rebuild ${timeLabel(freshness.lastSuccessAt)}. Evaluated ${timeLabel(freshness.evaluatedAt)}.`;
}

function flowSummary(period: AnalyticsPeriodData) {
  return ready(period.flow);
}

function FlowPanel({ periods, href }: MetricViewProps) {
  const groups: MetricGroup[] = [
    {
      label: "Recorded time by phase",
      rows: analyticsFlowPhaseSchema.options.map((phase) =>
        comparedRow(phase, phaseLabels[phase], periods, (period) => {
          const summary = flowSummary(period);
          const cell = summary?.flow[phase];
          if (
            !cell ||
            (cell.segments === 0 &&
              (!summary.freshness.sourceSnapshotAt || !summary.coverage.lifecycleWindowCovered))
          ) {
            return measuredPoint(
              null,
              { metric: "flow", facet: phase },
              durationLabel,
              "No covered time",
            );
          }
          return {
            value: cell.seconds,
            label: `${durationLabel(cell.seconds)} · ${numberFormat.format(cell.segments)} segments`,
            evidence: { metric: "flow", facet: phase },
          };
        }),
      ),
    },
  ];
  return (
    <MetricPanel
      id="work-flow"
      title="Work flow"
      definition="Wall-clock time summed across recorded session phase segments that intersect the dates shown. Open phases have no completed segment to contribute. Concurrent sessions can add time in parallel."
      groups={groups}
      href={href}
      compare={periods.comparison !== null}
      metadata={
        <PeriodNotes
          periods={periods}
          describe={(period) => {
            const summary = flowSummary(period);
            if (!summary) return "Flow data unavailable.";
            const openRequests = Object.values(summary.coverage.openRequests).reduce(
              (total, count) => total + count,
              0,
            );
            return (
              <>
                Revision {summary.metricRevisions.workflow_flow}.{" "}
                {summary.coverage.lifecycleWindowCovered
                  ? "Lifecycle window covered."
                  : "Partial lifecycle coverage."}{" "}
                Live capture began {timeLabel(summary.coverage.lifecycleFrom)}.{" "}
                {numberFormat.format(openRequests)} open-phase memberships,{" "}
                {numberFormat.format(summary.coverage.unplacedSessions)} sessions with unknown
                request dates. {flowFreshness(summary.freshness)}
              </>
            );
          }}
        />
      }
    />
  );
}

const deliveryKinds = { merge: "Request to merge", deployment: "Request to deployment" } as const;
const timingStats = [
  ["minSeconds", "Minimum"],
  ["p50Seconds", "Median"],
  ["p95Seconds", "95th percentile"],
  ["maxSeconds", "Maximum"],
] as const;
const deliverySamples = [
  ["total", "Requests in cohort"],
  ["measured", "Measured"],
  ["censored", "Endpoint not observed"],
  ["unknown", "Unknown timing"],
] as const;

function DeliveryPanel({ periods, href, query }: MetricViewProps & { query: AnalyticsQuery }) {
  const groups: MetricGroup[] = Object.entries(deliveryKinds).flatMap(([key, label]) => {
    const metric = key === "merge" ? "merge" : "deployment";
    return [
      {
        label: `${label} elapsed time`,
        rows: timingStats.map(([stat, name]) =>
          comparedRow(
            `${metric}-${stat}`,
            name,
            periods,
            (period) =>
              measuredPoint(
                flowSummary(period)?.[metric].distribution?.[stat] ?? null,
                { metric, facet: "measured" },
                durationLabel,
                "No measured samples",
              ),
            `${label} ${name}`,
          ),
        ),
      },
      {
        label: `${label} sample counts`,
        rows: deliverySamples.map(([status, name]) =>
          comparedRow(
            `${metric}-${status}`,
            name,
            periods,
            (period) => {
              const summary = flowSummary(period);
              const evidence: EvidenceLink =
                status === "total" ? { metric } : { metric, facet: status };
              if (!summary) return measuredPoint(null, evidence);
              if (
                summary[metric].total === 0 &&
                (!summary.freshness.sourceSnapshotAt || !summary.coverage.lifecycleWindowCovered)
              )
                return measuredPoint(null, evidence, undefined, "No covered requests");
              return measuredPoint(summary[metric][status], evidence);
            },
            `${label} ${name}`,
          ),
        ),
      },
    ];
  });
  return (
    <MetricPanel
      id="time-to-delivery"
      title="Time to delivery"
      definition="Elapsed wall-clock time from requests opened during the selected dates to their first verified canonical PR merge or first successful linked deployment. Measured requests form the duration distribution. Requests without an observed endpoint and requests with unknown timing remain in the cohort counts."
      groups={groups}
      href={href}
      compare={periods.comparison !== null}
      metadata={
        <PeriodNotes
          periods={periods}
          describe={(period) => {
            const summary = flowSummary(period);
            if (!summary) return "Delivery timing unavailable.";
            const { coverage, metricRevisions } = summary;
            return (
              <>
                Merge revision {metricRevisions.request_to_merge}. Deployment revision{" "}
                {metricRevisions.request_to_deployment}. PR capture began{" "}
                {timeLabel(coverage.pullRequestsFrom)}. Deployment capture began{" "}
                {timeLabel(coverage.deploymentsFrom)}. Provider completeness is{" "}
                {coverage.deploymentProviderCompleteness}. Environment{" "}
                {query.environment ?? "All observed environments"}.{" "}
                {flowFreshness(summary.freshness)}
              </>
            );
          }}
        />
      }
    />
  );
}

const costBases = { delivery: "Delivery", operating: "Operating" } as const;
const costAttempts = {
  measured: { field: "measuredAttempts", label: "Measured attempts" },
  estimated: { field: "estimatedAttempts", label: "Estimated attempts" },
  pending: { field: "pendingAttempts", label: "Pending attempts" },
  unavailable: { field: "unavailableAttempts", label: "Unavailable attempts" },
  unresolved: { field: "unresolvedAttributionAttempts", label: "Unresolved attribution" },
  unlinked: { field: "unlinkedAttempts", label: "Unlinked attempts" },
} as const;

function CostPanel({ periods, href }: MetricViewProps) {
  const ratioRows: MetricRow[] = [];
  const attemptGroups: MetricGroup[] = [];
  for (const basis of ["delivery", "operating"] as const) {
    const label = costBases[basis];
    const metric = basis === "delivery" ? "delivery-cost" : "operating-cost";
    ratioRows.push(
      comparedRow(`${metric}-ratio`, `${label} cost per observed merge`, periods, (period) => {
        const measure = ready(period.cost)?.costs[basis];
        const evidence = { metric, facet: "known" } as const;
        if (!measure) return measuredPoint(null, evidence);
        const value = measure.knownCostPerObservedMergeUsd;
        const state = {
          no_observed_merges: "No observed merges",
          unavailable: "Cost unavailable",
          partial: "Partial",
          estimated: "Estimated",
          measured: "Measured",
        }[measure.ratioState];
        return {
          value,
          label: value === null ? state : `${moneyFormat.format(value)} · ${state.toLowerCase()}`,
          evidence,
          also: { label: "Denominator evidence", evidence: { metric: "cost-merges" } },
        };
      }),
    );
    attemptGroups.push({
      label: `${label} attempt coverage`,
      rows: analyticsCostFacetSchema.options
        .filter((facet) => facet !== "known")
        .map((facet) => {
          const { field, label: attemptLabel } = costAttempts[facet];
          return comparedRow(
            `${metric}-${facet}`,
            attemptLabel,
            periods,
            (period) =>
              measuredPoint(ready(period.cost)?.costs[basis][field] ?? null, { metric, facet }),
            `${label} ${attemptLabel}`,
          );
        }),
    });
  }

  const groups = [
    { label: "Known USD per observed merge", rows: ratioRows },
    {
      label: "Cost numerators",
      rows: (["delivery", "operating"] as const).map((basis) => {
        const metric = basis === "delivery" ? "delivery-cost" : "operating-cost";
        return comparedRow(metric, `${costBases[basis]} known cost`, periods, (period) =>
          measuredPoint(
            ready(period.cost)?.costs[basis].knownCostUsd ?? null,
            { metric, facet: "known" },
            (value) => moneyFormat.format(value),
          ),
        );
      }),
    },
    {
      label: "Cost denominator",
      rows: [
        comparedRow("cost-denominator", "Observed canonical merges", periods, (period) =>
          measuredPoint(ready(period.cost)?.mergeCohort.observedMergeCount ?? null, {
            metric: "cost-merges",
          }),
        ),
      ],
    },
    ...attemptGroups,
  ];

  return (
    <MetricPanel
      id="cost-per-merge"
      title="Cost per merged PR"
      definition="Known product-attempt cost divided by observed canonical PR merges in the selected dates. Delivery cost follows attempts attributable to those merges. Operating cost follows attempts started during those dates. Pending or unavailable cost is excluded from known USD."
      groups={groups}
      href={href}
      compare={periods.comparison !== null}
      metadata={
        <PeriodNotes
          periods={periods}
          describe={(period) => {
            const summary = ready(period.cost);
            if (!summary) return "Cost data unavailable.";
            const { mergeCohort, costs } = summary;
            const unavailable = summary.unavailableCostCategories
              .map(({ category }) => category.replaceAll("_", " "))
              .join(", ");
            return (
              <>
                Delivery revision {costs.delivery.metricRevision}. Operating revision{" "}
                {costs.operating.metricRevision}.{" "}
                {mergeCohort.partialCoverage ||
                Date.parse(period.window.to) > Date.parse(summary.observedAt)
                  ? "Partial merge coverage."
                  : "Merge window covered."}{" "}
                PR capture began {timeLabel(mergeCohort.captureStartedAt)}.{" "}
                {numberFormat.format(mergeCohort.unresolvedMergeCount)} unresolved merges. Evaluated{" "}
                {timeLabel(summary.observedAt)}.
                {unavailable && ` Cost unavailable for ${unavailable}.`}
              </>
            );
          }}
        />
      }
    />
  );
}

function ThroughputPanel({ periods, href, query }: MetricViewProps & { query: AnalyticsQuery }) {
  const primary = ready(periods.primary.throughput);
  const comparison = periods.comparison && ready(periods.comparison.throughput);
  const buckets = new Map(
    [...(primary?.buckets ?? []), ...(comparison?.buckets ?? [])].map(({ key, label }) => [
      key,
      label,
    ]),
  );
  const groups: MetricGroup[] = [
    {
      label: "Canonical merges",
      rows: [
        comparedRow("observed-merges", "Observed canonical merges", periods, (period) =>
          measuredPoint(ready(period.throughput)?.observedMergeCount ?? null, {
            metric: "throughput",
          }),
        ),
      ],
    },
  ];
  if (buckets.size > 0) {
    groups.push({
      label: dimensionLabels[query.dimension],
      rows: [...buckets]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([bucket, label]) =>
          comparedRow(bucket, label, periods, (period) => {
            const summary = ready(period.throughput);
            const point = summary?.buckets.find(({ key }) => key === bucket);
            return measuredPoint(
              point?.mergeCount ?? (summary && !summary.bucketsTruncated ? 0 : null),
              { metric: "throughput", bucket },
              undefined,
              summary?.bucketsTruncated ? "Outside listed buckets" : "Unavailable",
            );
          }),
        ),
    });
  }
  return (
    <MetricPanel
      id="throughput"
      title="Pull request throughput"
      definition="Distinct canonical PRs with verified provider merge times within the selected dates. Each PR appears in one bucket per dimension. Mixed and partial buckets preserve differing or incomplete evidence from linked runs."
      groups={groups}
      href={href}
      compare={periods.comparison !== null}
      metadata={
        <PeriodNotes
          periods={periods}
          describe={(period) => {
            const summary = ready(period.throughput);
            if (!summary) return "Throughput data unavailable.";
            const { coverage } = summary;
            return (
              <>
                Revision {summary.metricRevision}.{" "}
                {coverage.partial || Date.parse(period.window.to) > Date.parse(summary.evaluatedAt)
                  ? "Partial merge coverage."
                  : "Merge window covered."}{" "}
                PR capture began {timeLabel(coverage.captureStartedAt)}.{" "}
                {numberFormat.format(coverage.unresolvedMergeCount)} unresolved merges,{" "}
                {numberFormat.format(summary.mixedMergeCount)} with multiple attributions,{" "}
                {numberFormat.format(summary.partialMergeCount)} with partial attribution. Evaluated{" "}
                {timeLabel(summary.evaluatedAt)}.
                {summary.bucketsTruncated &&
                  ` Listed buckets omit ${numberFormat.format(summary.omittedBucketMembershipCount)} memberships.`}
              </>
            );
          }}
        />
      }
    />
  );
}

const percentFormat = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2,
});
const revertCounts = [
  ["observedMergeCount", "Observed canonical merges", undefined],
  ["coveredMatureCount", "Covered mature merges", "covered"],
  ["revertedCoveredCount", "Verified reverts among covered merges", "covered-verified"],
  ["verifiedRevertedCount", "All originals with a verified revert", "verified"],
  ["immatureCount", "Window still open", "immature"],
  ["partialCount", "Partial coverage", "partial"],
  ["ambiguousCount", "Ambiguous relationship", "ambiguous"],
] as const;

function RevertPanel({ periods, href }: MetricViewProps) {
  const groups: MetricGroup[] = [
    {
      label: "Share of covered mature merges",
      rows: [
        comparedRow("revert-rate", "Verified revert rate", periods, (period) => {
          const result = ready(period.revert);
          const evidence = { metric: "revert", facet: "covered-verified" } as const;
          if (!result) return measuredPoint(null, evidence);
          const point = measuredPoint(
            result.revertRate,
            evidence,
            (value) => percentFormat.format(value),
            "No covered mature merges",
          );
          return {
            ...point,
            also: {
              label: "Denominator evidence",
              evidence: { metric: "revert", facet: "covered" },
            },
          };
        }),
      ],
    },
    {
      label: "Coverage and verified relationships",
      rows: revertCounts.map(([field, label, facet]) =>
        comparedRow(field, label, periods, (period) =>
          measuredPoint(ready(period.revert)?.[field] ?? null, { metric: "revert", facet }),
        ),
      ),
    },
  ];
  return (
    <MetricPanel
      id="revert-rate"
      title="Revert rate"
      definition="Canonical PRs merged in the selected dates with a verified revert within 30 days, divided by mature merges with complete evidence coverage for all 30 days. The clock starts at the original provider merge."
      groups={groups}
      href={href}
      compare={periods.comparison !== null}
      metadata={
        <PeriodNotes
          periods={periods}
          describe={(period) => {
            const summary = ready(period.revert);
            if (!summary) return "Revert data unavailable.";
            const { coverage } = summary;
            return (
              <>
                Revision {summary.metricRevision}.{" "}
                {coverage.partial ? "Partial revert coverage." : "Revert window covered."} PR
                capture began {timeLabel(coverage.captureStartedAt)}. Revert capture began{" "}
                {timeLabel(coverage.revertEvidenceStartedAt)}.{" "}
                {numberFormat.format(coverage.unresolvedOriginalCount)} unresolved originals.
                Evaluated {timeLabel(summary.window.asOf)}.
              </>
            );
          }}
        />
      }
    />
  );
}

export function AnalyticsMetrics({
  periods,
  href,
  query,
}: MetricViewProps & { query: AnalyticsQuery }) {
  return (
    <div className="space-y-6">
      <FlowPanel periods={periods} href={href} />
      <DeliveryPanel periods={periods} href={href} query={query} />
      <CostPanel periods={periods} href={href} />
      <ThroughputPanel periods={periods} href={href} query={query} />
      <RevertPanel periods={periods} href={href} />
    </div>
  );
}
