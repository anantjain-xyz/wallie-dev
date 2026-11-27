import { WORKSPACE_SCOPE_HINT } from "@/components/app-shell/workspace-location";
import { WorkspaceScopeHandoff } from "@/components/app-shell/workspace-scope-context";
import { loadWorkspaceRouteScope } from "@/components/app-shell/workspace-scope.server";
import { FACTORY_QUERY_PARAM } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { RunsList } from "@/features/wallie/runs-list";
import { loadRunsListData } from "@/features/wallie/runs-list-data";
import type { RunsListSearchParams } from "@/features/wallie/runs-list-state";

const factoryResetParams = ["agentId", "agentPromptRevisionId"];

export default async function RunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<RunsListSearchParams>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const snapshot = await loadWorkspaceRouteScope({
    route: "runs",
    workspaceSlug,
    search: query,
    resetParams: factoryResetParams,
  });
  const search = { ...query };
  delete search[FACTORY_QUERY_PARAM];
  delete search[WORKSPACE_SCOPE_HINT];
  const { factories, scope: selection } = snapshot;
  const handoff = <WorkspaceScopeHandoff snapshot={snapshot} />;
  if (selection.kind === "unavailable")
    return (
      <>
        {handoff}
        <FactoryUnavailable
          actions={
            <FactorySelector
              allowAll
              factories={factories}
              resetParams={factoryResetParams}
              selectedValue="unavailable"
            />
          }
          title="Runs"
          workspaceSlug={workspaceSlug}
        />
      </>
    );

  const data = await loadRunsListData(
    workspaceSlug,
    search,
    selection.kind === "factory" ? selection.factory.id : undefined,
  );
  return (
    <>
      {handoff}
      <RunsList
        data={data}
        factoryQuery={selection.kind === "factory" ? selection.factory.id : "all"}
        factoryName={selection.kind === "factory" ? selection.factory.name : undefined}
        factorySelector={
          <FactorySelector
            allowAll
            factories={factories}
            resetParams={factoryResetParams}
            selectedValue={selection.kind === "factory" ? selection.factory.id : "all"}
          />
        }
        initialNow={new Date().toISOString()}
      />
    </>
  );
}
