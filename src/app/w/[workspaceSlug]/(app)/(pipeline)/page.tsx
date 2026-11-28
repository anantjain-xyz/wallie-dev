import { WorkspaceScopeHandoff } from "@/components/app-shell/workspace-scope-context";
import { loadWorkspaceRouteScope } from "@/components/app-shell/workspace-scope.server";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { parseBoardStatus } from "@/features/pipeline/board-browse-history";
import { loadPipelineDashboardData } from "@/features/pipeline/data";
import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";
import { SessionsViewNavigation } from "@/features/sessions/components/sessions-view-navigation";

type WorkspaceHomePageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const boardFactoryResetParams = ["status"] as const;

export default async function WorkspaceHomePage({ params, searchParams }: WorkspaceHomePageProps) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const snapshot = await loadWorkspaceRouteScope({
    route: "board",
    workspaceSlug,
    search,
    resetParams: boardFactoryResetParams,
  });
  const { factories, scope: selection } = snapshot;
  const handoff = <WorkspaceScopeHandoff snapshot={snapshot} />;
  const factorySelector = (
    <FactorySelector
      allowAll
      factories={factories}
      resetParams={boardFactoryResetParams}
      selectedValue={selection.kind === "factory" ? selection.factory.id : selection.kind}
    />
  );
  if (selection.kind === "unavailable")
    return (
      <>
        {handoff}
        <FactoryUnavailable
          actions={
            <>
              <SessionsViewNavigation
                factory="unavailable"
                view="board"
                workspaceSlug={workspaceSlug}
              />
              {factorySelector}
            </>
          }
          title="Sessions"
          workspaceSlug={workspaceSlug}
        />
      </>
    );

  const factory = selection.kind === "factory" ? selection.factory : undefined;
  const data = await loadPipelineDashboardData(workspaceSlug, factory?.id);
  const initialNow = new Date().toISOString();

  return (
    <>
      {handoff}
      <PipelinePageClient
        factorySelector={factorySelector}
        initialData={{
          ...data,
          aggregateFactories: selection.kind === "all",
          showCreationOnboarding: !!factory?.isDefault && factory.status === "active",
        }}
        initialNow={initialNow}
        initialStatus={parseBoardStatus(search.status)}
        viewerId={snapshot.viewerId}
      />
    </>
  );
}
