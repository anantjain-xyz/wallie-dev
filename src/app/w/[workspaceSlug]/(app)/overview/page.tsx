import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { loadAnalyticsPeriods } from "@/features/factory-analytics/analytics-data";
import { parseAnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import {
  invalidOverviewFilters,
  OverviewFilters,
} from "@/features/factory-overview/overview-filters";
import { projectionHealthSchema } from "@/features/factory-overview/projection-health-contracts";
import { OverviewView } from "@/features/factory-overview/overview-view";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveAnalyticsFactory } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

const OVERVIEW_FACTORY_RESET_PARAMS = ["metric", "period", "facet", "bucket"] as const;

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
  const factory = resolveAnalyticsFactory(factories, search.factory);
  const factorySelector = (
    <FactorySelector
      factories={factories}
      resetParams={OVERVIEW_FACTORY_RESET_PARAMS}
      selectedValue={factory?.id ?? "unavailable"}
    />
  );
  if (!factory)
    return (
      <FactoryUnavailable
        actions={factorySelector}
        title="Overview"
        workspaceSlug={workspaceSlug}
      />
    );
  const now = new Date();
  const parsed = parseAnalyticsQuery(search, now);
  if (!parsed.success || parsed.data.evidence) {
    return (
      <PageContainer>
        <PageHeader
          actions={factorySelector}
          actionsRightOnDesktop
          description={factory.name}
          title="Overview"
        />
        <OverviewFilters
          factoryId={factory.id}
          workspaceSlug={workspaceSlug}
          {...invalidOverviewFilters(search, now)}
        />
      </PageContainer>
    );
  }
  const query = parsed.data;
  const { supabase, workspace } = await loadAuthenticatedWorkspaceContext(workspaceSlug);
  const [periods, health] = await Promise.all([
    loadAnalyticsPeriods({ supabase, workspaceId: workspace.id, factoryId: factory.id, query }),
    supabase.rpc("get_factory_flow_projection_health", {
      p_workspace_id: workspace.id,
      p_factory_id: factory.id,
    }),
  ]);
  const parsedHealth = projectionHealthSchema.safeParse(health.data);
  return (
    <OverviewView
      factory={factory}
      factorySelector={factorySelector}
      health={!health.error && parsedHealth.success ? parsedHealth.data : null}
      periods={periods}
      query={query}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
    />
  );
}
