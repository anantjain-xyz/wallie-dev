import type { ReactNode } from "react";
import { throughputLabel } from "./analytics-labels";

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

function comparisonNote(
  label: string,
  value: number | null,
  previous: number | null,
  format: (value: number) => string = (value) => numberFormat.format(value),
) {
  if (value === null || previous === null) return null;
  const delta = value - previous;
  return (
    <p className="type-secondary text-muted tabular-nums">
      {label}: {delta === 0 ? "No change" : `${delta > 0 ? "+" : "−"}${format(Math.abs(delta))}`}{" "}
      vs. previous period
    </p>
  );
}

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

function flowTotal(
  summary: NonNullable<ReturnType<typeof flowSummary>>,
  key: "segments" | "seconds",
) {
  return Object.values(summary.flow).reduce((sum, phase) => sum + phase[key], 0);
}

function FlowPanel({ periods, href }: MetricViewProps) {
  const current = flowSummary(periods.primary);
  const previous = periods.comparison && flowSummary(periods.comparison);
  const comparable =
    current?.coverage.lifecycleWindowCovered &&
    previous?.coverage.lifecycleWindowCovered &&
    current.freshness.status === "ready" &&
    previous.freshness.status === "ready" &&
    Date.parse(periods.primary.window.to) <= Date.parse(current.freshness.evaluatedAt) &&
    Date.parse(previous.window.to) <= Date.parse(previous.freshness.evaluatedAt) &&
    current.metricRevisions.workflow_flow === previous.metricRevisions.workflow_flow;
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
              summary ? "No covered time" : "Flow read unavailable",
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
      summary={
        current &&
        previous &&
        comparable &&
        comparisonNote(
          "Recorded phase time",
          flowTotal(current, "seconds"),
          flowTotal(previous, "seconds"),
          durationLabel,
        )
      }
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
            const segments = flowTotal(summary, "segments");
            return (
              <>
                Revision {summary.metricRevisions.workflow_flow}.{" "}
                {summary.coverage.lifecycleWindowCovered
                  ? "Lifecycle window covered."
                  : "Partial lifecycle coverage."}{" "}
                Live capture began {timeLabel(summary.coverage.lifecycleFrom)}.{" "}
                {(segments > 0 || summary.coverage.lifecycleWindowCovered) &&
                  `${numberFormat.format(segments)} recorded phase segments. `}
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

function DeliveryPanel({
  periods,
  href,
  query,
  environmentFilter,
}: MetricViewProps & {
  query: AnalyticsQuery;
  environmentFilter: ReactNode;
}) {
  const current = flowSummary(periods.primary);
  const previous = periods.comparison && flowSummary(periods.comparison);
  function timingState(
    summary: NonNullable<typeof current> | null,
    metric: "merge" | "deployment",
  ) {
    if (!summary) return "Delivery read unavailable";
    if (
      !summary.freshness.sourceSnapshotAt ||
      !summary.coverage.lifecycleWindowCovered ||
      (metric === "deployment"
        ? !summary.coverage.deploymentsFrom
        : !summary.coverage.pullRequestsFrom) ||
      summary[metric].unknown > 0
    )
      return "No measured samples · incomplete coverage";
    if (summary[metric].total === 0) return "No requests in this range";
    if (metric === "deployment" && query.environment)
      return "No measured deployments in this environment";
    return "No measured samples";
  }
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
                timingState(flowSummary(period), metric),
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
              if (!summary)
                return measuredPoint(null, evidence, undefined, "Delivery read unavailable");
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
      filters={environmentFilter}
      summary={
        <>
          {(Object.keys(deliveryKinds) as (keyof typeof deliveryKinds)[]).map((metric) => {
            const now = current?.[metric];
            const before = previous?.[metric];
            const revision = metric === "merge" ? "request_to_merge" : "request_to_deployment";
            const comparable =
              now &&
              before &&
              now.measured === now.total &&
              before.measured === before.total &&
              current?.coverage.lifecycleWindowCovered &&
              previous?.coverage.lifecycleWindowCovered &&
              current.freshness.status === "ready" &&
              previous.freshness.status === "ready" &&
              Date.parse(periods.primary.window.to) <= Date.parse(current.freshness.evaluatedAt) &&
              Date.parse(previous.window.to) <= Date.parse(previous.freshness.evaluatedAt) &&
              current.metricRevisions[revision] === previous.metricRevisions[revision];
            return (
              <div key={metric}>
                {now?.distribution ? (
                  <>
                    <p className="type-secondary text-muted">
                      {deliveryKinds[metric]}: {numberFormat.format(now.measured)} of{" "}
                      {numberFormat.format(now.total)} requests measured.
                    </p>
                    {comparable &&
                      comparisonNote(
                        `${deliveryKinds[metric]} median`,
                        now.distribution.p50Seconds,
                        before.distribution?.p50Seconds ?? null,
                        durationLabel,
                      )}
                  </>
                ) : (
                  <p className="type-secondary">
                    <strong>{deliveryKinds[metric]}:</strong> {timingState(current, metric)}
                  </p>
                )}
              </div>
            );
          })}
          {!current || (periods.comparison && !previous) ? (
            <a
              className="type-secondary text-accent underline underline-offset-4"
              href={href(query.evidence ?? undefined)}
            >
              Try again
            </a>
          ) : (
            (!current.merge.distribution || !current.deployment.distribution) && (
              <p className="type-secondary flex flex-wrap gap-x-4 text-accent">
                <a className="underline underline-offset-4" href="#analytics-filters">
                  Change dates
                </a>
              </p>
            )
          )}
        </>
      }
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
const costRatioLabels = {
  no_observed_merges: "No observed merges",
  unavailable: "Cost unavailable",
  partial: "Partial",
  estimated: "Estimated",
  measured: "Measured",
} satisfies Record<
  NonNullable<ReturnType<typeof readyCost>>["costs"]["delivery"]["ratioState"],
  string
>;

function readyCost(period: AnalyticsPeriodData) {
  return ready(period.cost);
}

function partialCostCoverage(
  period: AnalyticsPeriodData,
  summary: NonNullable<ReturnType<typeof readyCost>>,
) {
  return (
    summary.mergeCohort.partialCoverage ||
    Date.parse(period.window.to) > Date.parse(summary.observedAt)
  );
}
const costAttempts = {
  measured: { field: "measuredAttempts", label: "Measured attempts" },
  estimated: { field: "estimatedAttempts", label: "Estimated attempts" },
  pending: { field: "pendingAttempts", label: "Pending attempts" },
  unavailable: { field: "unavailableAttempts", label: "Unavailable attempts" },
  unresolved: { field: "unresolvedAttributionAttempts", label: "Unresolved attribution" },
  unlinked: { field: "unlinkedAttempts", label: "Unlinked attempts" },
} as const;

function CostPanel({ periods, href }: MetricViewProps) {
  const current = ready(periods.primary.cost);
  const previous = periods.comparison && ready(periods.comparison.cost);
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
        const state = costRatioLabels[measure.ratioState];
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
      summary={
        current &&
        (["delivery", "operating"] as const).map((basis) => {
          const now = current.costs[basis];
          const before = previous?.costs[basis];
          const comparable =
            previous &&
            before &&
            periods.comparison &&
            now.ratioState === "measured" &&
            before.ratioState === "measured" &&
            now.metricRevision === before.metricRevision &&
            !partialCostCoverage(periods.primary, current) &&
            !partialCostCoverage(periods.comparison, previous);
          return (
            comparable && (
              <div key={basis}>
                {comparisonNote(
                  `Known ${basis} cost per observed merge`,
                  now.knownCostPerObservedMergeUsd,
                  before.knownCostPerObservedMergeUsd,
                  (value) => moneyFormat.format(value),
                )}
              </div>
            )
          );
        })
      }
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
                {partialCostCoverage(period, summary)
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

function readyThroughput(period: AnalyticsPeriodData) {
  return ready(period.throughput);
}

function partialThroughputCoverage(
  period: AnalyticsPeriodData,
  summary: NonNullable<ReturnType<typeof readyThroughput>>,
) {
  return summary.coverage.partial || Date.parse(period.window.to) > Date.parse(summary.evaluatedAt);
}

function ThroughputPanel({
  periods,
  href,
  query,
  bucketLabels,
  dimensionFilter,
}: MetricViewProps & {
  query: AnalyticsQuery;
  bucketLabels: ReadonlyMap<string, string>;
  dimensionFilter: ReactNode;
}) {
  const primary = ready(periods.primary.throughput);
  const comparison = periods.comparison && ready(periods.comparison.throughput);
  const comparable =
    primary &&
    comparison &&
    periods.comparison &&
    !partialThroughputCoverage(periods.primary, primary) &&
    !partialThroughputCoverage(periods.comparison, comparison) &&
    primary.metricRevision === comparison.metricRevision;
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
          comparedRow(
            bucket,
            throughputLabel(bucketLabels, query.dimension, bucket, label),
            periods,
            (period) => {
              const summary = ready(period.throughput);
              const point = summary?.buckets.find(({ key }) => key === bucket);
              return measuredPoint(
                point?.mergeCount ?? (summary && !summary.bucketsTruncated ? 0 : null),
                { metric: "throughput", bucket },
                undefined,
                summary?.bucketsTruncated ? "Outside listed buckets" : "Unavailable",
              );
            },
          ),
        ),
    });
  }
  return (
    <MetricPanel
      id="throughput"
      title="Pull request throughput"
      filters={dimensionFilter}
      summary={comparisonNote(
        "Observed canonical merges",
        primary?.observedMergeCount ?? null,
        comparable ? comparison.observedMergeCount : null,
      )}
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
                {partialThroughputCoverage(period, summary)
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
  const current = ready(periods.primary.revert);
  const previous = periods.comparison && ready(periods.comparison.revert);
  const comparable =
    current &&
    previous &&
    !current.coverage.partial &&
    !previous.coverage.partial &&
    current.metricRevision === previous.metricRevision &&
    current.coveredMatureCount === current.observedMergeCount &&
    previous.coveredMatureCount === previous.observedMergeCount;
  const groups: MetricGroup[] = [
    {
      label: "Share of covered mature merges",
      scale: "percent",
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
      summary={
        current &&
        comparisonNote(
          "Verified revert rate",
          current.revertRate,
          comparable ? previous.revertRate : null,
          (value) =>
            `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value * 100)} pp`,
        )
      }
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

export function AnalyticsHighlights({ period }: { period: AnalyticsPeriodData }) {
  const flow = flowSummary(period);
  const cost = readyCost(period);
  const throughput = readyThroughput(period);
  const revert = ready(period.revert);
  const flowDelayed = flow && ["paused", "building", "failed"].includes(flow.freshness.status);
  const flowCurrent = flow?.freshness.status === "ready" && flow.freshness.sourceSnapshotAt;
  const fullFlowCoverage =
    flow?.coverage.lifecycleWindowCovered &&
    Date.parse(period.window.to) <= Date.parse(flow.freshness.evaluatedAt);
  const state = flowDelayed ? "Delayed" : "Unavailable";
  const partialThroughput = throughput && partialThroughputCoverage(period, throughput);
  const outcomes = [
    {
      id: "work-flow",
      title: "Work flow",
      values: [
        {
          value:
            !flowCurrent || !flow
              ? state
              : fullFlowCoverage || flowTotal(flow, "segments") > 0
                ? durationLabel(flowTotal(flow, "seconds"))
                : "No covered time",
          note: !flowCurrent
            ? undefined
            : fullFlowCoverage
              ? "Recorded phase time"
              : "Partial lifecycle coverage",
        },
      ],
    },
    {
      id: "time-to-delivery",
      title: "Time to delivery",
      values:
        flowCurrent && flow
          ? (["merge", "deployment"] as const).map((kind) => {
              const duration = flow[kind].distribution?.p50Seconds;
              return {
                value: duration === undefined ? "No measured samples" : durationLabel(duration),
                note: kind === "merge" ? "Median to merge" : "Median to deploy",
              };
            })
          : [{ value: state }],
    },
    {
      id: "cost-per-merge",
      title: "Cost per merged PR",
      values: cost
        ? (["delivery", "operating"] as const).map((basis) => {
            const measure = cost.costs[basis];
            const value = measure.knownCostPerObservedMergeUsd;
            return {
              value:
                value === null ? costRatioLabels[measure.ratioState] : moneyFormat.format(value),
              note: [
                value === null
                  ? costBases[basis]
                  : basis === "delivery"
                    ? "Known delivery"
                    : "Known operating",
                value === null || measure.ratioState === "measured"
                  ? null
                  : costRatioLabels[measure.ratioState],
                partialCostCoverage(period, cost) && measure.ratioState !== "partial"
                  ? "partial merge coverage"
                  : null,
              ]
                .filter(Boolean)
                .join(" · "),
            };
          })
        : [{ value: "Unavailable" }],
    },
    {
      id: "throughput",
      title: "PR throughput",
      values: [
        {
          value: throughput
            ? partialThroughput && throughput.observedMergeCount === 0
              ? "Incomplete"
              : numberFormat.format(throughput.observedMergeCount)
            : "Unavailable",
          note: throughput
            ? partialThroughput
              ? "Partial merge coverage"
              : "Observed merges"
            : undefined,
        },
      ],
    },
    {
      id: "revert-rate",
      title: "Revert rate",
      values: [
        {
          value: !revert
            ? "Unavailable"
            : revert.revertRate === null
              ? "No covered mature merges"
              : percentFormat.format(revert.revertRate),
          note:
            revert?.revertRate != null
              ? "Of covered mature merges"
              : revert?.coverage.partial
                ? "Partial revert coverage"
                : undefined,
        },
      ],
    },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 px-4 py-4 sm:grid-cols-3 sm:px-5 lg:grid-cols-5">
      {outcomes.map(({ id, title, values }) => (
        <div className="min-w-0 space-y-1" key={id}>
          <dt className="type-label font-medium">
            <a
              className="rounded-sm underline decoration-border-strong underline-offset-4 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              href={`#${id}`}
            >
              {title}
            </a>
          </dt>
          {values.map(({ value, note }: { value: string; note?: string }, index) => (
            <dd className="min-w-0" key={index}>
              <span className="type-secondary block break-words font-semibold tabular-nums">
                {value}
              </span>
              {note && <span className="type-label block break-words text-muted">{note}</span>}
            </dd>
          ))}
        </div>
      ))}
    </dl>
  );
}

export function AnalyticsMetrics({
  periods,
  href,
  query,
  bucketLabels,
  environmentFilter,
  dimensionFilter,
}: MetricViewProps & {
  query: AnalyticsQuery;
  bucketLabels: ReadonlyMap<string, string>;
  environmentFilter: ReactNode;
  dimensionFilter: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <FlowPanel periods={periods} href={href} />
      <DeliveryPanel
        periods={periods}
        href={href}
        query={query}
        environmentFilter={environmentFilter}
      />
      <CostPanel periods={periods} href={href} />
      <ThroughputPanel
        periods={periods}
        href={href}
        query={query}
        bucketLabels={bucketLabels}
        dimensionFilter={dimensionFilter}
      />
      <RevertPanel periods={periods} href={href} />
    </div>
  );
}
