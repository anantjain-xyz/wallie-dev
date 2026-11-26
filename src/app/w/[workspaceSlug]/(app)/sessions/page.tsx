import { cookies } from "next/headers";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadSessionListPageData } from "@/features/sessions/list/data";
import { SessionsPage } from "@/features/sessions/list/sessions-page";
import { workspaceSessionsPath } from "@/lib/routes";
import {
  readSessionSearchContinuation,
  sessionSearchCookieName,
} from "@/lib/session-search-continuation";
import { SESSION_SEARCH_RESUME_PARAM } from "@/lib/workspace-return-path";

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
  if (selection.kind === "unavailable")
    return (
      <FactoryUnavailable
        actions={<FactorySelector allowAll factories={factories} selectedValue="unavailable" />}
        title="Sessions"
        workspaceSlug={workspaceSlug}
      />
    );

  const factory = selection.kind === "factory" ? selection.factory : undefined;
  let browseSearch = search;
  if (search.q === undefined && typeof search[SESSION_SEARCH_RESUME_PARAM] === "string") {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(search)) {
      for (const entry of typeof value === "string" ? [value] : (value ?? [])) {
        query.append(key, entry);
      }
    }
    const savedSearch = readSessionSearchContinuation(
      `${workspaceSessionsPath(workspaceSlug)}?${query}`,
      (await cookies()).get(sessionSearchCookieName)?.value,
    );
    if (savedSearch !== null) browseSearch = { ...search, q: savedSearch };
  }
  const data = await loadSessionListPageData(workspaceSlug, browseSearch, factory?.id);
  const initialNow = new Date().toISOString();

  return (
    <SessionsPage
      factoryQuery={typeof search.factory === "string" ? search.factory : undefined}
      factorySelector={
        <FactorySelector
          allowAll
          factories={factories}
          selectedValue={factory ? factory.id : "all"}
        />
      }
      initialData={data}
      initialNow={initialNow}
      readOnly={selection.kind === "all"}
      showCreationOnboarding={!!factory?.isDefault && factory.status === "active"}
    />
  );
}
