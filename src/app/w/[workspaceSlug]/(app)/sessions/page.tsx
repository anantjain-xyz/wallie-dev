import { cookies } from "next/headers";
import Link from "next/link";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import {
  FACTORY_QUERY_PARAM,
  resolveFactorySelection,
} from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";
import { SessionsViewTitle } from "@/features/sessions/components/sessions-view-navigation";
import { loadSessionListPageData } from "@/features/sessions/list/data";
import { SessionsPage } from "@/features/sessions/list/sessions-page";
import { workspaceSessionsPath } from "@/lib/routes";
import {
  readSessionSearchContinuation,
  sessionSearchCookieName,
} from "@/lib/session-search-continuation";
import { SESSION_SEARCH_RESUME_PARAM } from "@/lib/workspace-list-return-path";

type SessionsPageProps = {
  params: Promise<{
    workspaceSlug: string;
  }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SessionsRoutePage({ params, searchParams }: SessionsPageProps) {
  const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
  const factories = await loadWorkspaceFactoryOptions(workspaceSlug);
  const requested = search[FACTORY_QUERY_PARAM];
  const activeFactories = factories.filter((factory) => factory.status === "active");
  const selection =
    requested === undefined
      ? activeFactories.length
        ? resolveFactorySelection(activeFactories, undefined, { useFirstVisible: true })
        : { kind: "all" as const }
      : resolveFactorySelection(factories, requested);
  if (selection.kind === "unavailable" || factories.length === 0)
    return (
      <PageContainer className="pt-5 sm:pt-10">
        <PageHeader
          actions={
            factories.length > 0 && (
              <FactorySelector allowAll factories={factories} selectedValue="unavailable" />
            )
          }
          actionsRightOnDesktop
          title={
            <SessionsViewTitle factory="unavailable" view="list" workspaceSlug={workspaceSlug} />
          }
          titleAsChild
        />
        <section className="ui-sheet px-6 py-12 text-center">
          <h2 className="text-sm font-semibold text-foreground">Factory unavailable</h2>
          <p className="mt-2 text-sm text-muted">
            {factories.length > 0
              ? "Choose a factory you can access, or view sessions across accessible factories."
              : "No factories are available to your account. Ask a workspace admin for access."}
          </p>
          {factories.length > 0 ? (
            <Link
              className="ui-button mt-4"
              href={workspaceSessionsPath(workspaceSlug, { factory: "all" })}
            >
              View accessible sessions
            </Link>
          ) : null}
        </section>
      </PageContainer>
    );

  const factory = selection.kind === "factory" ? selection.factory : undefined;
  const factoryQuery =
    selection.kind === "all"
      ? "all"
      : requested !== undefined || !factory?.isDefault
        ? factory?.id
        : undefined;
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
  const data = await loadSessionListPageData(
    workspaceSlug,
    { ...browseSearch, factory: factoryQuery },
    factory?.id,
  );
  const initialNow = new Date().toISOString();

  return (
    <SessionsPage
      factoryQuery={factoryQuery}
      factoryId={factory?.id}
      factoryName={factory?.name}
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
