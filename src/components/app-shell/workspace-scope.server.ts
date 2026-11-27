import "server-only";

import { redirect } from "next/navigation";

import {
  matchWorkspaceLocation,
  resolveWorkspaceScope,
  resolveWorkspaceScopeHint,
  workspaceLocationForRoute,
  workspaceScopeLocationKey,
  type WorkspaceLocationQuery,
  type WorkspaceRoute,
} from "@/components/app-shell/workspace-location";
import type { WorkspaceScopeSnapshot } from "@/components/app-shell/workspace-scope-context";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FACTORY_QUERY_PARAM } from "@/features/factories/factory-selection";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

export async function loadWorkspaceRouteScope({
  picker = "header",
  resetParams,
  route,
  search,
  workspaceSlug,
}: {
  picker?: "header" | "guarded" | "leaf";
  resetParams?: readonly string[];
  route: WorkspaceRoute;
  search: WorkspaceLocationQuery;
  workspaceSlug: string;
}): Promise<WorkspaceScopeSnapshot> {
  const location = workspaceLocationForRoute(route, workspaceSlug);
  const [{ user, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const forward = resolveWorkspaceScopeHint(location, search, factories);
  if (forward) redirect(forward);

  const value = search[FACTORY_QUERY_PARAM];
  const scope = resolveWorkspaceScope(location, factories, value);
  return {
    factories,
    locationKey: workspaceScopeLocationKey(location.indexPath, value),
    picker: scope.kind === "pick" || scope.kind === "unavailable" ? "header" : picker,
    resetParams,
    scope,
    viewerId: user.id,
    workspaceId: workspace.id,
  };
}

export async function loadWorkspaceResourceScope({
  factoryId,
  pathname,
  workspaceSlug,
}: {
  factoryId: string | null;
  pathname: string;
  workspaceSlug: string;
}): Promise<WorkspaceScopeSnapshot> {
  const location = matchWorkspaceLocation(pathname, workspaceSlug);
  const [{ user, workspace }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  return {
    factories,
    locationKey: workspaceScopeLocationKey(pathname),
    picker: "locked",
    scope: resolveWorkspaceScope(location, factories, undefined, factoryId),
    viewerId: user.id,
    workspaceId: workspace.id,
  };
}
