import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { loadAnalyticsPeriods } from "@/features/factory-analytics/analytics-data";
import { parseAnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import { projectionHealthSchema } from "@/features/factory-overview/projection-health-contracts";
import { OverviewView } from "@/features/factory-overview/overview-view";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveAnalyticsFactory } from "@/features/factories/factory-selection";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { workspaceOverviewPath } from "@/lib/routes";

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const parsed = parseAnalyticsQuery(search);
  if (!parsed.success || parsed.data.evidence) {
    return (
      <PageContainer>
        <PageHeader title="Overview" />
        <section className="ui-sheet space-y-3 px-6 py-8">
          <h2 className="type-section-title">Invalid Overview filters</h2>
          <p className="type-secondary text-muted">
            Use a date range of 1 to 366 days and supported filters.
          </p>
          <Link
            className="type-secondary font-medium underline"
            href={workspaceOverviewPath(workspaceSlug)}
          >
            Reset Overview filters
          </Link>
        </section>
      </PageContainer>
    );
  }
  const query = parsed.data;
  const [{ supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const factory = resolveAnalyticsFactory(factories, query.factoryId);
  if (!factory) return <FactoryUnavailable title="Overview" workspaceSlug={workspaceSlug} />;
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
      health={!health.error && parsedHealth.success ? parsedHealth.data : null}
      periods={periods}
      query={query}
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
    />
  );
}
