import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import {
  loadAnalyticsEvidence,
  loadAnalyticsPeriods,
} from "@/features/factory-analytics/analytics-data";
import { parseAnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import { analyticsCohortHref } from "@/features/factory-analytics/analytics-view-shared";
import { RoutingCanaryComparison } from "@/features/factory-analytics/routing-canary-comparison";
import { loadRoutingCanaryComparison } from "@/features/factory-analytics/routing-canary-data";
import { resolveAnalyticsFactory } from "@/features/factories/factory-selection";
import { AnalyticsView } from "@/features/factory-analytics/analytics-view";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { ScorerTrends } from "@/features/factory-scorers/scorer-trends";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
import { parseScorerTrendQuery } from "@/lib/factory-evaluations/score-trend-query";
import { loadScoreTrendPanel } from "@/lib/factory-evaluations/score-trends";
import { workspaceAnalyticsPath } from "@/lib/routes";

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const parsed = parseAnalyticsQuery(search);
  if (!parsed.success) {
    return (
      <PageContainer>
        <PageHeader title="Analytics" />
        <section className="ui-sheet space-y-3 px-6 py-8">
          <h2 className="type-section-title">Invalid analytics filters</h2>
          <p className="type-secondary text-muted">
            Use a date range of 1 to 366 days and supported filters.
          </p>
          <a
            className="type-secondary font-medium underline"
            href={workspaceAnalyticsPath(workspaceSlug)}
          >
            Reset analytics filters
          </a>
        </section>
      </PageContainer>
    );
  }
  const query = parsed.data;
  const [{ currentMember, supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const factory = resolveAnalyticsFactory(factories, query.factoryId);
  if (!factory) return <FactoryUnavailable title="Analytics" />;

  const scope = { supabase, workspaceId: workspace.id, factoryId: factory.id, query };
  const trendQuery = parseScorerTrendQuery(search, {
    from: query.from.slice(0, 10),
    to: query.to.slice(0, 10),
  });
  const unavailableCanary = {
    kind: "unavailable",
    alertRequested: Boolean(query.routingAlertId),
  } as const;
  const [periods, evidence, trend, canary] = await Promise.all([
    loadAnalyticsPeriods(scope),
    loadAnalyticsEvidence(scope),
    trendQuery ? loadScoreTrendPanel(supabase, scope, trendQuery).catch(() => null) : null,
    factory.canManage
      ? loadRoutingCanaryComparison(supabase, {
          ...scope,
          canaryId: query.routingCanaryId,
          alertId: query.routingAlertId,
        }).catch(() => unavailableCanary)
      : query.routingCanaryId
        ? unavailableCanary
        : null,
  ]);
  const latestAlert = canary?.kind === "ready" ? canary.latestAlert : undefined;
  const latestAlertHref = latestAlert
    ? `${analyticsCohortHref(workspace.slug, factory.id, { ...query, routingCanaryId: latestAlert.canaryId, routingAlertId: latestAlert.id })}#routing-canary`
    : undefined;
  const liveReportHref =
    canary?.kind === "retained"
      ? `${analyticsCohortHref(workspace.slug, factory.id, { ...query, routingAlertId: undefined })}#routing-canary`
      : undefined;
  return (
    <AnalyticsView
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      factory={factory}
      query={query}
      periods={periods}
      evidence={evidence}
      routingCanaryComparison={
        canary ? (
          <RoutingCanaryComparison
            state={canary}
            workspaceSlug={workspaceSlug}
            factoryId={factory.id}
            canManageFactory={factory.status === "active" && isWorkspaceOperator(currentMember)}
            latestAlertHref={latestAlertHref}
            liveReportHref={liveReportHref}
          />
        ) : null
      }
      scorerTrends={
        <ScorerTrends
          data={trend}
          path={workspaceAnalyticsPath(workspaceSlug)}
          preserved={{
            factory: factory.id,
            dimension: query.dimension,
            environment: query.environment ?? undefined,
            compare: query.comparison ? "previous" : undefined,
            routingCanary: query.routingCanaryId,
            routingAlert: query.routingAlertId,
          }}
          query={trendQuery}
          selectRevision
          workspaceSlug={workspace.slug}
        />
      }
    />
  );
}
