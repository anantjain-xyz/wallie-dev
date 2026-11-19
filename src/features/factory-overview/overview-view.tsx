import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { AnalyticsFilters } from "@/features/factory-analytics/analytics-filters";
import type {
  AnalyticsPeriodData,
  loadAnalyticsPeriods,
} from "@/features/factory-analytics/analytics-data";
import {
  type AnalyticsQuery,
  analyticsFlowPhaseSchema,
} from "@/features/factory-analytics/analytics-query";
import {
  analyticsCohortHref,
  type AnalyticsHref,
  durationLabel,
  type EvidenceLink,
  moneyFormat,
  numberFormat,
  timeLabel,
} from "@/features/factory-analytics/analytics-view-shared";
import { OverviewProjectionHealth } from "@/features/factory-overview/overview-projection-health";
import type { ProjectionHealth } from "@/features/factory-overview/projection-health-contracts";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { workspaceInboxPath, workspaceOverviewPath, workspaceSessionsPath } from "@/lib/routes";

const percentFormat = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 2,
});

type SummaryRow = {
  name: string;
  value: string;
  evidence: EvidenceLink;
  denominator?: EvidenceLink;
};
type OutcomeSummary = { title: string; note: string; rows: SummaryRow[] };

function ready<T>(result: { status: "ready"; data: T } | { status: "unavailable" }) {
  return result.status === "ready" ? result.data : null;
}

const phaseLabels = {
  queued: "Queued",
  active: "Active",
  blocked: "Blocked",
  review: "Review",
  delivery: "Delivery",
  unknown: "Unknown phase",
} satisfies Record<(typeof analyticsFlowPhaseSchema.options)[number], string>;

function summarize(period: AnalyticsPeriodData, health: ProjectionHealth | null): OutcomeSummary[] {
  const flow = ready(period.flow);
  const flowReady = health?.status === "ready" && flow?.freshness.status === "ready";
  const flowStatus =
    health?.status === "paused" || flow?.freshness.status === "paused"
      ? "Projection paused."
      : health?.status === "failed" || flow?.freshness.status === "failed"
        ? "Projection failed."
        : health?.status === "building" || flow?.freshness.status === "building"
          ? "Projection updating. The previous snapshot may be stale."
          : "Projection health unavailable.";
  const flowUnavailable = `Data unavailable. ${flowStatus}`;
  const cost = ready(period.cost);
  const throughput = ready(period.throughput);
  const revert = ready(period.revert);

  return [
    {
      title: "Work flow",
      note: flowReady
        ? flow.coverage.lifecycleWindowCovered
          ? "Recorded phase time."
          : "Recorded phase time has partial lifecycle coverage."
        : flowUnavailable,
      rows: flowReady
        ? analyticsFlowPhaseSchema.options.map((phase) => ({
            name: phaseLabels[phase],
            value:
              flow.flow[phase].segments === 0 && !flow.coverage.lifecycleWindowCovered
                ? "No covered time"
                : durationLabel(flow.flow[phase].seconds),
            evidence: { metric: "flow", facet: phase },
          }))
        : [],
    },
    {
      title: "Time to delivery",
      note: flowReady
        ? `Median wall-clock time from request to its first verified endpoint. Deployment coverage is ${flow.coverage.deploymentProviderCompleteness}.`
        : flowUnavailable,
      rows: flowReady
        ? (["merge", "deployment"] as const).map((metric) => {
            const sample = flow[metric];
            return {
              name: metric === "merge" ? "Request to merge" : "Request to deployment",
              value: sample.distribution
                ? `${durationLabel(sample.distribution.p50Seconds)} · ${numberFormat.format(sample.measured)} of ${numberFormat.format(sample.total)} measured`
                : "No measured samples",
              evidence: { metric, facet: "measured" },
              denominator: { metric },
            };
          })
        : [],
    },
    {
      title: "Cost per merged PR",
      note: cost
        ? `${cost.mergeCohort.partialCoverage || Date.parse(period.window.to) > Date.parse(cost.observedAt) ? "Partial merge coverage." : "Merge window covered."} PR capture began ${timeLabel(cost.mergeCohort.captureStartedAt)}.`
        : "Cost data unavailable.",
      rows: cost
        ? (["delivery", "operating"] as const).map((basis) => {
            const measure = cost.costs[basis];
            const label = {
              no_observed_merges: "No observed merges",
              unavailable: "Cost unavailable",
              partial: "Partial",
              estimated: "Estimated",
              measured: "Measured",
            }[measure.ratioState];
            return {
              name: basis === "delivery" ? "Delivery cost" : "Operating cost",
              value:
                measure.knownCostPerObservedMergeUsd === null
                  ? label
                  : `${moneyFormat.format(measure.knownCostPerObservedMergeUsd)} · ${label.toLowerCase()}`,
              evidence:
                basis === "delivery"
                  ? { metric: "delivery-cost", facet: "known" }
                  : { metric: "operating-cost", facet: "known" },
              denominator: { metric: "cost-merges" },
            };
          })
        : [],
    },
    {
      title: "Pull request throughput",
      note: throughput
        ? `${throughput.coverage.partial || Date.parse(period.window.to) > Date.parse(throughput.evaluatedAt) ? "Partial merge coverage." : "Merge window covered."} PR capture began ${timeLabel(throughput.coverage.captureStartedAt)}.`
        : "Throughput data unavailable.",
      rows: throughput
        ? [
            {
              name: "Observed canonical merges",
              value: numberFormat.format(throughput.observedMergeCount),
              evidence: { metric: "throughput" },
            },
          ]
        : [],
    },
    {
      title: "Revert rate",
      note: revert
        ? `${revert.coverage.partial ? "Partial revert coverage." : "Revert window covered."} Revert capture began ${timeLabel(revert.coverage.revertEvidenceStartedAt)}.`
        : "Revert data unavailable.",
      rows: revert
        ? [
            {
              name: "Verified revert rate",
              value:
                revert.revertRate === null
                  ? "No covered mature merges"
                  : `${percentFormat.format(revert.revertRate)} · ${numberFormat.format(revert.revertedCoveredCount)} of ${numberFormat.format(revert.coveredMatureCount)} covered`,
              evidence: { metric: "revert", facet: "covered-verified" },
              denominator: { metric: "revert", facet: "covered" },
            },
            {
              name: "Window still open",
              value: numberFormat.format(revert.immatureCount),
              evidence: { metric: "revert", facet: "immature" },
            },
          ]
        : [],
    },
  ];
}

export function OverviewView({
  factory,
  health,
  periods,
  query,
  workspaceId,
  workspaceSlug,
}: {
  factory: FactorySelectionOption;
  health: ProjectionHealth | null;
  periods: Awaited<ReturnType<typeof loadAnalyticsPeriods>>;
  query: AnalyticsQuery;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const href: AnalyticsHref = (evidence) =>
    analyticsCohortHref(workspaceSlug, factory.id, query, evidence);
  const primary = summarize(periods.primary, health);
  const previous = periods.comparison ? summarize(periods.comparison, health) : null;
  const factoryQuery = { factory: factory.id };
  return (
    <PageContainer>
      <PageHeader
        title="Overview"
        description={factory.name}
        actionsRightOnDesktop
        actions={
          <>
            <Link
              className="ui-button px-3 py-2 text-sm"
              href={workspaceInboxPath(workspaceSlug, factoryQuery)}
              prefetch={false}
            >
              Open Inbox
            </Link>
            <Link
              className="ui-button px-3 py-2 text-sm"
              href={workspaceSessionsPath(workspaceSlug, factoryQuery)}
              prefetch={false}
            >
              View sessions
            </Link>
            <Link className="ui-button-primary px-3 py-2 text-sm" href={href()} prefetch={false}>
              Open Analytics
            </Link>
          </>
        }
      />
      <AnalyticsFilters
        action={workspaceOverviewPath(workspaceSlug)}
        factoryId={factory.id}
        query={query}
      />
      <div className="space-y-6">
        <OverviewProjectionHealth
          factoryId={factory.id}
          workspaceId={workspaceId}
          health={health}
          captureStartedAt={ready(periods.primary.flow)?.coverage.lifecycleFrom ?? null}
        />
        <div className="grid items-start gap-4 md:grid-cols-2">
          {primary.map((summary, index) => (
            <SummaryCard
              key={summary.title}
              summary={summary}
              previous={previous?.[index]}
              href={href}
            />
          ))}
        </div>
      </div>
    </PageContainer>
  );
}

function SummaryCard({
  summary,
  previous,
  href,
}: {
  summary: OutcomeSummary;
  previous: OutcomeSummary | undefined;
  href: AnalyticsHref;
}) {
  return (
    <section className="ui-sheet min-w-0" aria-label={summary.title}>
      <header className="space-y-1 border-b border-border px-4 py-3 sm:px-5">
        <h2 className="type-section-title">{summary.title}</h2>
        <p className="type-secondary text-muted">{summary.note}</p>
      </header>
      <div
        className={
          previous ? "divide-y divide-border lg:grid lg:grid-cols-2 lg:divide-x lg:divide-y-0" : ""
        }
      >
        <SummaryPeriod
          summary={summary}
          period="primary"
          title={previous ? "Current period" : undefined}
          href={href}
        />
        {previous && (
          <SummaryPeriod
            summary={previous}
            period="compare"
            title="Previous period"
            note={previous.note === summary.note ? undefined : previous.note}
            href={href}
          />
        )}
      </div>
    </section>
  );
}

function SummaryPeriod({
  summary,
  period,
  title,
  note,
  href,
}: {
  summary: OutcomeSummary;
  period: "primary" | "compare";
  title?: string;
  note?: string;
  href: AnalyticsHref;
}) {
  if (!title && summary.rows.length === 0) return null;
  return (
    <div className="min-w-0 px-4 py-3 sm:px-5">
      {title && <h3 className="type-label mb-1 text-muted">{title}</h3>}
      {note && <p className="type-secondary mb-2 text-muted">{note}</p>}
      <dl className="type-secondary space-y-2">
        {summary.rows.map((row) => (
          <div
            className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
            key={row.name}
          >
            <dt className="text-muted">{row.name}</dt>
            <dd className="flex min-w-0 max-w-full flex-wrap justify-end gap-x-2 gap-y-0.5 text-right tabular-nums">
              <Link
                className="max-w-full scroll-mt-20 break-words font-medium underline decoration-border-strong underline-offset-4 hover:text-accent"
                href={href({ ...row.evidence, period })}
                prefetch={false}
              >
                <span className="sr-only">
                  {row.name}, {title ?? "Current period"},{" "}
                </span>
                {row.value}
              </Link>
              {row.denominator && (
                <Link
                  className="type-label text-muted underline underline-offset-4 hover:text-accent"
                  href={href({ ...row.denominator, period })}
                  prefetch={false}
                >
                  Denominator
                  <span className="sr-only">
                    {" "}
                    for {row.name}, {title ?? "Current period"}
                  </span>
                </Link>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
