import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadPipelineDashboardData } from "@/features/pipeline/data";
import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";

type WorkspaceHomePageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function WorkspaceHomePage({ params, searchParams }: WorkspaceHomePageProps) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
  const selection = resolveFactorySelection(factories, search[FACTORY_QUERY_PARAM]);
  if (selection.kind === "unavailable")
    return <FactoryUnavailable title="Pipeline" workspaceSlug={workspaceSlug} />;

  const factory = selection.kind === "factory" ? selection.factory : undefined;
  const data = await loadPipelineDashboardData(workspaceSlug, factory?.id);
  const initialNow = new Date().toISOString();

  return (
    <PipelinePageClient
      initialData={{
        ...data,
        showCreationOnboarding: !!factory?.isDefault && factory.status === "active",
      }}
      initialNow={initialNow}
    />
  );
}
