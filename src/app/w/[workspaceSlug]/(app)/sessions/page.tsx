import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadSessionListPageData } from "@/features/sessions/list/data";
import { SessionsPage } from "@/features/sessions/list/sessions-page";

type SessionsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SessionsRoutePage({ params, searchParams }: SessionsPageProps) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
  const selection = resolveFactorySelection(factories, search[FACTORY_QUERY_PARAM]);
  if (selection.kind === "unavailable") return <FactoryUnavailable title="Sessions" />;

  const factory = selection.kind === "factory" ? selection.factory : undefined;
  const data = await loadSessionListPageData(workspaceSlug, search, factory?.id);
  const initialNow = new Date().toISOString();

  return (
    <SessionsPage
      factoryQuery={typeof search.factory === "string" ? search.factory : undefined}
      initialData={data}
      initialNow={initialNow}
      readOnly={selection.kind === "all"}
      showCreationOnboarding={!!factory?.isDefault && factory.status === "active"}
    />
  );
}
