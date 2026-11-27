import { cookies } from "next/headers";
import Link from "next/link";

import { WorkspaceScopeHandoff } from "@/components/app-shell/workspace-scope-context";
import { loadWorkspaceRouteScope } from "@/components/app-shell/workspace-scope.server";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { FACTORY_QUERY_PARAM } from "@/features/factories/factory-selection";
import { SessionsFactoryControls } from "@/features/sessions/components/sessions-factory-controls";
import { SessionsViewTitle } from "@/features/sessions/components/sessions-view-navigation";
import { loadSessionListPageData } from "@/features/sessions/list/data";
import { SessionsPage } from "@/features/sessions/list/sessions-page";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";
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
  const [snapshot, { currentMember }] = await Promise.all([
    loadWorkspaceRouteScope({ route: "sessions", workspaceSlug, search }),
    loadAuthenticatedWorkspaceContext(workspaceSlug),
  ]);
  const requested = search[FACTORY_QUERY_PARAM];
  const { factories, scope: selection } = snapshot;
  const handoff = <WorkspaceScopeHandoff snapshot={snapshot} />;
  const canManageFactories = isWorkspaceOperator(currentMember);
  const factorySelector =
    factories.length > 0 || canManageFactories ? (
      <SessionsFactoryControls
        canManageFactories={canManageFactories}
        factories={factories}
        selectedValue={
          selection.kind === "factory"
            ? selection.factory.id
            : factories.length === 0
              ? "unavailable"
              : selection.kind
        }
        workspaceSlug={workspaceSlug}
      />
    ) : null;
  if (selection.kind === "unavailable" || factories.length === 0)
    return (
      <PageContainer className="pt-5 sm:pt-10">
        {handoff}
        <PageHeader
          actions={factorySelector}
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
    <>
      {handoff}
      <SessionsPage
        factoryQuery={factoryQuery}
        factoryId={factory?.id}
        factoryName={factory?.name}
        factorySelector={factorySelector}
        initialData={data}
        initialNow={initialNow}
        readOnly={selection.kind === "all"}
        showCreationOnboarding={!!factory?.isDefault && factory.status === "active"}
      />
    </>
  );
}
