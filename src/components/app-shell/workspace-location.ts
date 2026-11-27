import {
  FACTORY_QUERY_PARAM,
  factorySwitchHref,
  withFactoryQuery,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import {
  workspaceActivityPath,
  workspaceAgentsPath,
  workspaceAnalyticsPath,
  workspaceAutomationPreviewPath,
  workspaceBasePath,
  workspaceBenchmarksPath,
  workspaceContextPath,
  workspaceFactoryDefinitionPath,
  workspaceFailureGroupsPath,
  workspaceGovernancePath,
  workspaceImprovementsPath,
  workspaceInboxPath,
  workspaceMemoryPath,
  workspaceRunsPath,
  workspaceScorersPath,
  workspaceSessionsPath,
  workspaceSettingsPath,
  workspaceWorkflowsPath,
} from "@/lib/routes";
import { SESSION_SEARCH_RESUME_PARAM } from "@/lib/workspace-list-return-path";

export type WorkspaceDestination =
  | "inbox"
  | "sessions"
  | "activity"
  | "insights"
  | "factory"
  | "settings";

type FactoryAccess = "managed" | "active" | "active-managed";

type LocationRule = {
  destination: WorkspaceDestination;
  path: (slug: string) => string;
  mode: "aggregate" | "single" | "global";
  access?: FactoryAccess;
  details?: true;
  defaultToAll?: true;
  tab?: string;
};

const routes = {
  inbox: { destination: "inbox", path: workspaceInboxPath, mode: "aggregate", defaultToAll: true },
  board: { destination: "sessions", path: workspaceBasePath, mode: "aggregate", tab: "Board" },
  sessions: {
    destination: "sessions",
    path: workspaceSessionsPath,
    mode: "aggregate",
    tab: "List",
    details: true,
  },
  runs: {
    destination: "activity",
    path: workspaceRunsPath,
    mode: "aggregate",
    tab: "Runs",
    details: true,
  },
  feed: {
    destination: "activity",
    path: workspaceActivityPath,
    mode: "aggregate",
    tab: "Feed",
    defaultToAll: true,
  },
  analytics: {
    destination: "insights",
    path: workspaceAnalyticsPath,
    mode: "single",
    tab: "Analytics",
  },
  failures: {
    destination: "insights",
    path: workspaceFailureGroupsPath,
    mode: "single",
    tab: "Failures",
    details: true,
  },
  improvements: {
    destination: "insights",
    path: workspaceImprovementsPath,
    mode: "single",
    tab: "Failures",
    details: true,
  },
  benchmarks: {
    destination: "insights",
    path: workspaceBenchmarksPath,
    mode: "single",
    tab: "Benchmarks",
    details: true,
  },
  definition: {
    destination: "factory",
    path: workspaceFactoryDefinitionPath,
    mode: "single",
    access: "active",
    tab: "Configuration",
  },
  agents: {
    destination: "factory",
    path: workspaceAgentsPath,
    mode: "single",
    tab: "Configuration",
    details: true,
  },
  scorers: {
    destination: "factory",
    path: workspaceScorersPath,
    mode: "single",
    tab: "Configuration",
    details: true,
  },
  automations: {
    destination: "factory",
    path: workspaceAutomationPreviewPath,
    mode: "single",
    access: "active-managed",
    tab: "Configuration",
  },
  workflows: {
    destination: "factory",
    path: workspaceWorkflowsPath,
    mode: "single",
    access: "active-managed",
    tab: "Configuration",
    details: true,
  },
  governance: {
    destination: "factory",
    path: workspaceGovernancePath,
    mode: "single",
    access: "managed",
    tab: "Configuration",
  },
  context: {
    destination: "factory",
    path: workspaceContextPath,
    mode: "single",
    access: "managed",
    tab: "Knowledge",
  },
  memory: {
    destination: "factory",
    path: workspaceMemoryPath,
    mode: "single",
    access: "managed",
    tab: "Knowledge",
  },
  settings: { destination: "settings", path: workspaceSettingsPath, mode: "global" },
} as const satisfies Record<string, LocationRule>;

export type WorkspaceRoute = keyof typeof routes;
type WorkspaceLocation = Omit<LocationRule, "path" | "details"> & {
  route: WorkspaceRoute;
  indexPath: string;
  detail: boolean;
};

const entries = Object.entries(routes) as [WorkspaceRoute, LocationRule][];

export const WORKSPACE_SCOPE_HINT = "lastFactory";
export type WorkspaceLocationQuery = Record<string, string | readonly string[] | undefined>;

export function workspaceFactorySwitchHref(
  pathname: string,
  search: string,
  factory: string,
  resetParams: readonly string[] = [],
  hash = "",
) {
  const href = factorySwitchHref(pathname, search, factory, [
    "afterId",
    "workflowActivation",
    WORKSPACE_SCOPE_HINT,
    SESSION_SEARCH_RESUME_PARAM,
    ...resetParams,
  ]);
  const knownAnchor =
    (/^\/w\/[^/]+\/activity\/?$/u.test(pathname) &&
      (hash === "#activity-sessions" || hash === "#activity-runs")) ||
    (/^\/w\/[^/]+\/settings\/factory-definition\/?$/u.test(pathname) &&
      (hash === "#factory-setup" || hash === "#definition-field-stages"));
  return knownAnchor ? href + hash : href;
}

export function workspaceLocationForRoute(
  route: WorkspaceRoute,
  workspaceSlug: string,
): WorkspaceLocation {
  const { path, ...rule }: LocationRule = routes[route];
  return { ...rule, route, indexPath: path(workspaceSlug), detail: false };
}

export function matchWorkspaceLocation(
  pathname: string,
  workspaceSlug: string,
): WorkspaceLocation | undefined {
  const normalized = pathname.replace(/\/$/u, "");
  for (const [route, { path, details, ...rule }] of entries) {
    const indexPath = path(workspaceSlug);
    if (normalized === indexPath) return { ...rule, route, indexPath, detail: false };
    if (details && normalized.startsWith(`${indexPath}/`)) {
      return { ...rule, route, indexPath, detail: true };
    }
  }
}

export type WorkspaceScope =
  | { kind: "global" }
  | { kind: "all" }
  | { kind: "factory"; factory: FactorySelectionOption }
  | { kind: "pick" }
  | { kind: "unavailable" }
  | { kind: "resource-pending" };

export function workspaceScopeOptions(
  location: Pick<WorkspaceLocation, "access">,
  factories: readonly FactorySelectionOption[],
) {
  const managed = location.access === "managed" || location.access === "active-managed";
  const active = location.access === "active" || location.access === "active-managed";
  return factories.filter(
    (factory) => (!managed || factory.canManage) && (!active || factory.status === "active"),
  );
}

export function resolveWorkspaceScope(
  location: WorkspaceLocation | undefined,
  factories: readonly FactorySelectionOption[],
  request: string | readonly string[] | undefined,
  resourceFactoryId?: string | null,
): WorkspaceScope {
  if (!location || location.mode === "global") return { kind: "global" };
  const allowed = workspaceScopeOptions(location, factories);
  const exact = (id: string | null): WorkspaceScope => {
    const factory = id && allowed.find((option) => option.id === id.toLowerCase());
    return factory ? { kind: "factory", factory } : { kind: "unavailable" };
  };
  if (location.detail) {
    return resourceFactoryId === undefined
      ? { kind: "resource-pending" }
      : exact(resourceFactoryId);
  }
  if (request === "all") return { kind: location.mode === "aggregate" ? "all" : "pick" };
  if (typeof request === "string") return exact(request);
  if (request !== undefined) return { kind: "unavailable" };

  const active = factories.filter((factory) => factory.status === "active");
  const only = active.length === 1 ? allowed.find(({ id }) => id === active[0].id) : undefined;
  if (only) return { kind: "factory", factory: only };
  if (location.mode === "single") return { kind: "pick" };
  const fallback =
    !location.defaultToAll &&
    (active.find((option) => option.isDefault) ??
      (location.route === "sessions" ? active[0] : undefined));
  return fallback ? { kind: "factory", factory: fallback } : { kind: "all" };
}

export function workspaceScopeHref(
  route: WorkspaceRoute,
  workspaceSlug: string,
  scope: WorkspaceScope,
  asPreference = false,
) {
  const { indexPath, mode } = workspaceLocationForRoute(route, workspaceSlug);
  if (mode === "global") return indexPath;
  if (asPreference) {
    const value = workspaceScopePreference(scope);
    return value
      ? `${indexPath}?${new URLSearchParams({ [WORKSPACE_SCOPE_HINT]: value })}`
      : indexPath;
  }
  switch (scope.kind) {
    case "factory":
      return withFactoryQuery(indexPath, scope.factory.id);
    case "all":
    case "pick":
      return withFactoryQuery(indexPath, "all");
    case "unavailable":
      return withFactoryQuery(indexPath, "unavailable");
    default:
      return indexPath;
  }
}

export function readFactoryRequest(search: Pick<URLSearchParams, "getAll"> | null | undefined) {
  const values = search?.getAll(FACTORY_QUERY_PARAM) ?? [];
  return values.length < 2 ? values[0] : values;
}

export function workspaceScopeLocationKey(pathname: string, request?: string | readonly string[]) {
  return JSON.stringify([pathname.replace(/\/$/u, ""), request ?? null]);
}

export function resolveWorkspaceScopeHint(
  location: WorkspaceLocation,
  search: WorkspaceLocationQuery,
  factories: readonly FactorySelectionOption[],
) {
  const hint = search[WORKSPACE_SCOPE_HINT];
  if (location.mode === "global" || hint === undefined || search[FACTORY_QUERY_PARAM] !== undefined)
    return null;

  const restored =
    typeof hint === "string"
      ? restoreWorkspaceScope(hint, workspaceScopeOptions(location, factories))
      : { kind: "global" as const };
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (key === WORKSPACE_SCOPE_HINT) continue;
    for (const entry of typeof value === "string" ? [value] : (value ?? []))
      next.append(key, entry);
  }
  const factory = workspaceScopePreference(restored);
  if (factory) next.set(FACTORY_QUERY_PARAM, factory);
  return `${location.indexPath}${next.size ? `?${next}` : ""}`;
}

export function workspaceScopePreferenceKey(viewerId: string, workspaceId: string) {
  return `wallie:scope:v1:${viewerId}:${workspaceId}`;
}

export function restoreWorkspaceScope(
  value: string | null,
  factories: readonly FactorySelectionOption[],
): WorkspaceScope {
  if (value === "all") return { kind: "all" };
  const factory = factories.find(({ id, status }) => id === value && status === "active");
  return factory ? { kind: "factory", factory } : { kind: "global" };
}

export function workspaceScopePreference(scope: WorkspaceScope) {
  if (scope.kind === "all") return "all";
  return scope.kind === "factory" && scope.factory.status === "active" ? scope.factory.id : null;
}
