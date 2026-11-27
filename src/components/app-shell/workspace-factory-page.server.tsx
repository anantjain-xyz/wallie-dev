import "server-only";

import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import {
  workspaceLocationForRoute,
  workspaceScopeOptions,
  WORKSPACE_SCOPE_HINT,
  type WorkspaceLocationQuery,
  type WorkspaceRoute,
} from "@/components/app-shell/workspace-location";
import { WorkspaceScopeHandoff } from "@/components/app-shell/workspace-scope-context";
import { WorkspaceScopeRequired } from "@/components/app-shell/workspace-scope-required";
import { loadWorkspaceRouteScope } from "@/components/app-shell/workspace-scope.server";
import {
  isWorkspaceOperator,
  loadAuthenticatedWorkspaceContext,
} from "@/features/workspaces/authenticated-context";

type PageProps<Search> = {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Search>;
};

export function scopeFactoryIndex<Search extends WorkspaceLocationQuery>(
  Page: (props: PageProps<Search>) => ReactNode | Promise<ReactNode>,
  {
    picker,
    resetParams,
    route,
    title,
  }: {
    picker?: "header" | "guarded" | "leaf";
    resetParams?: readonly string[];
    route: WorkspaceRoute;
    title: string;
  },
) {
  return async function ScopedFactoryIndex({ params, searchParams }: PageProps<Search>) {
    const [{ workspaceSlug }, search] = await Promise.all([params, searchParams]);
    if (route === "definition") {
      const { currentMember } = await loadAuthenticatedWorkspaceContext(workspaceSlug);
      if (!isWorkspaceOperator(currentMember)) notFound();
    }
    const snapshot = await loadWorkspaceRouteScope({
      picker,
      resetParams,
      route,
      search,
      workspaceSlug,
    });
    if (
      route === "automations" &&
      !workspaceScopeOptions(workspaceLocationForRoute(route, workspaceSlug), snapshot.factories)
        .length
    )
      notFound();

    if (snapshot.scope.kind !== "factory") {
      return (
        <WorkspaceScopeRequired
          route={route}
          snapshot={snapshot}
          title={title}
          workspaceSlug={workspaceSlug}
        />
      );
    }
    const scopedQuery = { ...search, factory: snapshot.scope.factory.id };
    Reflect.deleteProperty(scopedQuery, WORKSPACE_SCOPE_HINT);
    return (
      <>
        <WorkspaceScopeHandoff snapshot={snapshot} />
        <Page params={params} searchParams={Promise.resolve(scopedQuery)} />
      </>
    );
  };
}
