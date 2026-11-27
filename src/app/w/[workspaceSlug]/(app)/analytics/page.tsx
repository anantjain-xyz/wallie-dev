import { Suspense } from "react";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import {
  loadAnalyticsEvidence,
  loadAnalyticsPeriods,
  loadDeploymentEnvironments,
} from "@/features/factory-analytics/analytics-data";
import { loadAnalyticsLabels } from "@/features/factory-analytics/analytics-labels";
import {
  analyticsCoreFields,
  analyticsEvidenceFields,
  analyticsFieldsHref,
  analyticsScorerFields,
} from "@/features/factory-analytics/analytics-navigation";
import { recoverAnalyticsFilters } from "@/features/factory-analytics/analytics-query";
import { AnalyticsReportingFilters } from "@/features/factory-analytics/analytics-reporting-filters";
import { RoutingCanaryComparison } from "@/features/factory-analytics/routing-canary-comparison";
import { loadRoutingCanaryComparison } from "@/features/factory-analytics/routing-canary-data";
import { ReportingHealth } from "@/features/factory-analytics/reporting-health";
import { resolveAnalyticsFactory } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { AnalyticsDetailsView, AnalyticsView } from "@/features/factory-analytics/analytics-view";
import { timeLabel } from "@/features/factory-analytics/analytics-view-shared";
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

const ANALYTICS_FACTORY_RESET_PARAMS = [
  "metric",
  "period",
  "facet",
  "bucket",
  "scorerRevision",
  "cohort",
  "scoreSnapshot",
  "evaluationDay",
  "evaluationStatus",
  "beforeRunFinishedAt",
  "beforeScoreRun",
  "beforeRevisionAt",
  "beforeRevisionPolicy",
  "beforeCohortAt",
  "beforeCohortPolicy",
  "routingCanary",
  "routingAlert",
  "cursor",
] as const;

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
  const factory = resolveAnalyticsFactory(factories, search.factory);
  if (!factory)
    return (
      <FactoryUnavailable
        actions={
          <FactorySelector
            factories={factories}
            resetParams={ANALYTICS_FACTORY_RESET_PARAMS}
            selectedValue="unavailable"
          />
        }
        description={
          factories.length ? "Choose a factory you can access to see its reports." : undefined
        }
        title="Analytics"
        workspaceSlug={workspaceSlug}
      />
    );

  const { query, errors, dates } = recoverAnalyticsFilters(search);
  if (search.overviewFilters === "invalid") {
    errors.other =
      "Some filters from this Overview bookmark couldn’t be carried over. Review and apply the filters to see the report.";
  }
  const { currentMember, supabase, workspace } =
    await loadAuthenticatedWorkspaceContext(workspaceSlug);
  const scope = { supabase, workspaceId: workspace.id, factoryId: factory.id, query };
  const path = workspaceAnalyticsPath(workspaceSlug);
  const reportingWindow = {
    from: query.from.slice(0, 10),
    to: query.to.slice(0, 10),
  };
  const trendQuery = parseScorerTrendQuery({ ...search, ...reportingWindow });
  const scorerFields = analyticsScorerFields(trendQuery);
  const environmentsRead = loadDeploymentEnvironments(scope);
  const factorySelector = (
    <FactorySelector
      factories={factories}
      resetParams={ANALYTICS_FACTORY_RESET_PARAMS}
      selectedValue={factory.id}
    />
  );
  if (Object.values(errors).some(Boolean)) {
    return (
      <PageContainer>
        <PageHeader actions={factorySelector} actionsRightOnDesktop title="Analytics" />
        <AnalyticsReportingFilters
          action={path}
          dates={dates}
          environments={await environmentsRead}
          errors={errors}
          factoryId={factory.id}
          query={query}
          scorerFields={scorerFields}
        />
      </PageContainer>
    );
  }
  const periodsRead = loadAnalyticsPeriods(scope);
  return (
    <AnalyticsView
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      factory={factory}
      factorySelector={factorySelector}
      scorerFields={scorerFields}
      query={query}
      periods={periodsRead}
      reportingHealth={
        <Suspense
          fallback={
            <p className="type-secondary px-4 py-3 text-muted">Loading reporting health…</p>
          }
        >
          <ReportingHealth
            captureStartedAt={
              <Suspense fallback="Loading…">
                <LifecycleCaptureStart periods={periodsRead} />
              </Suspense>
            }
            factoryId={factory.id}
            supabase={supabase}
            workspaceId={workspace.id}
          />
        </Suspense>
      }
      details={
        <Suspense fallback={<p className="type-secondary text-muted">Loading report details…</p>}>
          <AnalyticsDetails
            scope={scope}
            workspaceSlug={workspace.slug}
            canReadCanary={factory.canManage === true}
            canManageCanary={factory.status === "active" && isWorkspaceOperator(currentMember)}
            periodsRead={periodsRead}
            environmentsRead={environmentsRead}
            reportingWindow={reportingWindow}
            trendQuery={trendQuery}
            scorerFields={scorerFields}
          />
        </Suspense>
      }
    />
  );
}

async function LifecycleCaptureStart({
  periods,
}: {
  periods: ReturnType<typeof loadAnalyticsPeriods>;
}) {
  const {
    primary: { flow },
  } = await periods;
  return timeLabel(flow.status === "ready" ? flow.data.coverage.lifecycleFrom : null);
}

async function AnalyticsDetails({
  scope,
  workspaceSlug,
  canReadCanary,
  canManageCanary,
  periodsRead,
  environmentsRead,
  reportingWindow,
  trendQuery,
  scorerFields,
}: {
  scope: Parameters<typeof loadAnalyticsPeriods>[0];
  workspaceSlug: string;
  canReadCanary: boolean;
  canManageCanary: boolean;
  periodsRead: ReturnType<typeof loadAnalyticsPeriods>;
  environmentsRead: ReturnType<typeof loadDeploymentEnvironments>;
  reportingWindow: { from: string; to: string };
  trendQuery: ReturnType<typeof parseScorerTrendQuery>;
  scorerFields: ReturnType<typeof analyticsScorerFields>;
}) {
  const { supabase, query, factoryId } = scope;
  const path = workspaceAnalyticsPath(workspaceSlug);
  const coreFields = analyticsCoreFields(factoryId, query);
  const evidenceFields = analyticsEvidenceFields(query.evidence);
  const unavailableCanary = {
    kind: "unavailable",
    alertRequested: Boolean(query.routingAlertId),
  } as const;
  const [periods, evidence, trend, canary, environments] = await Promise.all([
    periodsRead,
    loadAnalyticsEvidence(scope),
    trendQuery ? loadScoreTrendPanel(supabase, scope, trendQuery).catch(() => null) : null,
    canReadCanary
      ? loadRoutingCanaryComparison(supabase, {
          ...scope,
          canaryId: query.routingCanaryId,
          alertId: query.routingAlertId,
        }).catch(() => unavailableCanary)
      : query.routingCanaryId
        ? unavailableCanary
        : null,
    environmentsRead,
  ]);
  const latestAlert = canary?.kind === "ready" ? canary.latestAlert : undefined;
  const labels = await loadAnalyticsLabels(
    scope,
    [periods.primary, periods.comparison],
    evidence?.status === "ready" ? evidence.data : null,
  );
  const canaryHref = (override: Record<string, string | undefined>) =>
    analyticsFieldsHref(path, { ...coreFields, ...evidenceFields, ...scorerFields, ...override }) +
    "#routing-canary";
  const latestAlertHref = latestAlert
    ? canaryHref({ routingCanary: latestAlert.canaryId, routingAlert: latestAlert.id })
    : undefined;
  const liveReportHref =
    canary?.kind === "retained" ? canaryHref({ routingAlert: undefined }) : undefined;
  return (
    <AnalyticsDetailsView
      workspaceSlug={workspaceSlug}
      factoryId={factoryId}
      environments={environments}
      labels={labels}
      scorerFields={scorerFields}
      query={query}
      periods={periods}
      evidence={evidence}
      routingCanaryComparison={
        canary ? (
          <RoutingCanaryComparison
            state={canary}
            workspaceSlug={workspaceSlug}
            factoryId={factoryId}
            canManageFactory={canManageCanary}
            latestAlertHref={latestAlertHref}
            liveReportHref={liveReportHref}
          />
        ) : null
      }
      scorerTrends={
        <ScorerTrends
          data={trend}
          path={path}
          preserved={{ ...coreFields, ...evidenceFields }}
          query={trendQuery}
          reportingWindow={reportingWindow}
          selectRevision
          workspaceSlug={workspaceSlug}
        />
      }
    />
  );
}
