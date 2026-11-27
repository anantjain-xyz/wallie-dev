import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { parseBoardStatus } from "@/features/pipeline/board-browse-history";
import { loadPipelineDashboardData } from "@/features/pipeline/data";
import { PipelinePageClient } from "@/features/pipeline/pipeline-page-client";
import { SessionsViewNavigation } from "@/features/sessions/components/sessions-view-navigation";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

type WorkspaceHomePageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const boardFactoryResetParams = ["status"] as const;

export default async function WorkspaceHomePage({ params, searchParams }: WorkspaceHomePageProps) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
  const selection = resolveFactorySelection(factories, search[FACTORY_QUERY_PARAM]);
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
            <FactorySelector
              allowAll
              factories={factories}
              resetParams={boardFactoryResetParams}
              selectedValue="unavailable"
            />
          </>
        }
        title="Sessions"
        workspaceSlug={workspaceSlug}
      />
    );

  const factory = selection.kind === "factory" ? selection.factory : undefined;
  const [data, { user }] = await Promise.all([
    loadPipelineDashboardData(workspaceSlug, factory?.id),
    loadAuthenticatedWorkspaceContext(workspaceSlug),
  ]);
  const initialNow = new Date().toISOString();

  return (
    <PipelinePageClient
      factorySelector={
        <FactorySelector
          allowAll
          factories={factories}
          resetParams={boardFactoryResetParams}
          selectedValue={factory ? factory.id : "all"}
        />
      }
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
