import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { parseBoardStatus } from "@/features/pipeline/board-browse-history";
import { loadPipelineDashboardData } from "@/features/pipeline/data";
import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";
import { SessionsFactoryControls } from "@/features/sessions/components/sessions-factory-controls";
import { SessionsViewNavigation } from "@/features/sessions/components/sessions-view-navigation";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";

type WorkspaceHomePageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const boardFactoryResetParams = ["status"] as const;

export default async function WorkspaceHomePage({ params, searchParams }: WorkspaceHomePageProps) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const [factories, { currentMember, user }] = await Promise.all([
    loadWorkspaceFactoryOptions(workspaceSlug),
    loadAuthenticatedWorkspaceContext(workspaceSlug),
  ]);
  const selection = resolveFactorySelection(factories, search[FACTORY_QUERY_PARAM]);
  const factorySelector = (
    <SessionsFactoryControls
      canManageFactories={isWorkspaceOperator(currentMember)}
      factories={factories}
      resetParams={boardFactoryResetParams}
      selectedValue={selection.kind === "factory" ? selection.factory.id : selection.kind}
      workspaceSlug={workspaceSlug}
    />
  );
  if (selection.kind === "unavailable")
    return (
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
    );

  const factory = selection.kind === "factory" ? selection.factory : undefined;
  const data = await loadPipelineDashboardData(workspaceSlug, factory?.id);
  const initialNow = new Date().toISOString();

  return (
    <PipelinePageClient
      factorySelector={factorySelector}
      initialData={{
        ...data,
        aggregateFactories: selection.kind === "all",
        creationFactoryName: factories.find(
          ({ isDefault, status }) => isDefault && status === "active",
        )?.name,
        showCreationOnboarding: !!factory?.isDefault && factory.status === "active",
      }}
      initialNow={initialNow}
      initialStatus={parseBoardStatus(search.status)}
      viewerId={user.id}
    />
  );
}
