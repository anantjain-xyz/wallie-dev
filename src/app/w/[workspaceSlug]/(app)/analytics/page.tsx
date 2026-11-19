import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import {
  loadAnalyticsEvidence,
  loadAnalyticsPeriods,
} from "@/features/factory-analytics/analytics-data";
import { parseAnalyticsQuery } from "@/features/factory-analytics/analytics-query";
import { resolveAnalyticsFactory } from "@/features/factories/factory-selection";
import { AnalyticsView } from "@/features/factory-analytics/analytics-view";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
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
  const [{ supabase, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const factory = resolveAnalyticsFactory(factories, query.factoryId);
  if (!factory) return <FactoryUnavailable title="Analytics" />;

  const scope = { supabase, workspaceId: workspace.id, factoryId: factory.id, query };
  const [periods, evidence] = await Promise.all([
    loadAnalyticsPeriods(scope),
    loadAnalyticsEvidence(scope),
  ]);
  return (
    <AnalyticsView
      workspaceId={workspace.id}
      workspaceSlug={workspace.slug}
      factory={factory}
      query={query}
      periods={periods}
      evidence={evidence}
    />
  );
}
