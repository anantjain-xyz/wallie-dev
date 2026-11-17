import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { RunsList } from "@/features/wallie/runs-list";
import { loadRunsListData } from "@/features/wallie/runs-list-data";
import type { RunsListSearchParams } from "@/features/wallie/runs-list-state";

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<RunsListSearchParams>;
}) {
  const [{ workspaceSlug }, { [FACTORY_QUERY_PARAM]: factoryQuery, ...search }] = await Promise.all(
    [params, searchParams],
  );
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
  const selection = resolveFactorySelection(factories, factoryQuery);
  if (selection.kind === "unavailable") return <FactoryUnavailable title="Runs" />;

  const data = await loadRunsListData(
    workspaceSlug,
    search,
    selection.kind === "factory" ? selection.factory.id : undefined,
  );
  return (
    <RunsList
      data={data}
      factoryQuery={typeof factoryQuery === "string" ? factoryQuery : undefined}
      initialNow={new Date().toISOString()}
    />
  );
}
