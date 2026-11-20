import {
  workspaceActivityPath,
  workspaceAgentsPath,
  workspaceAnalyticsPath,
  workspaceBasePath,
  workspaceContextPath,
  workspaceGovernancePath,
  workspaceInboxPath,
  workspaceMemoryPath,
  workspaceOverviewPath,
  workspaceRunsPath,
  workspaceScorersPath,
  workspaceSessionsPath,
} from "@/lib/routes";

export const FACTORY_QUERY_PARAM = "factory";

export type FactorySelectionOption = {
  id: string;
  canManage?: boolean;
  name: string;
  isDefault: boolean;
  status: "active" | "archived";
};

export type FactorySelection =
  | { kind: "factory"; factory: FactorySelectionOption }
  | { kind: "all" }
  | { kind: "unavailable" };

export function resolveFactorySelection(
  factories: readonly FactorySelectionOption[],
  value: string | string[] | null | undefined,
): FactorySelection {
  if (value === "all") return { kind: "all" };
  const requestedId = typeof value === "string" ? value.toLowerCase() : null;

  const match =
    value == null
      ? factories.find((factory) => factory.isDefault)
      : factories.find((factory) => factory.id === requestedId);
  return match ? { kind: "factory", factory: match } : { kind: "unavailable" };
}

export function resolveAnalyticsFactory(
  factories: readonly FactorySelectionOption[],
  requested: string | string[] | null | undefined,
): FactorySelectionOption | null {
  if (requested == null)
    return factories.find((factory) => factory.isDefault) ?? factories[0] ?? null;
  if (typeof requested !== "string") return null;
  const id = requested.toLowerCase();
  return factories.find((factory) => factory.id === id) ?? null;
}

export function resolveGovernanceFactorySelection(
  factories: readonly FactorySelectionOption[],
  value: string | string[] | null | undefined,
): Exclude<FactorySelection, { kind: "all" }> {
  const managed = factories.filter(({ canManage }) => canManage);
  const requestedId = typeof value === "string" ? value.toLowerCase() : null;
  const factory =
    value == null
      ? (managed.find(({ isDefault }) => isDefault) ?? managed[0])
      : managed.find(({ id }) => id === requestedId);
  return factory ? { kind: "factory", factory } : { kind: "unavailable" };
}

export function isFactoryAggregatePath(pathname: string, workspaceSlug: string) {
  return (
    pathname === workspaceBasePath(workspaceSlug) ||
    pathname === workspaceSessionsPath(workspaceSlug) ||
    pathname === workspaceRunsPath(workspaceSlug) ||
    pathname === workspaceInboxPath(workspaceSlug) ||
    pathname === workspaceActivityPath(workspaceSlug)
  );
}

export function defaultsToAllFactories(pathname: string, workspaceSlug: string) {
  return (
    pathname === workspaceActivityPath(workspaceSlug) ||
    pathname === workspaceInboxPath(workspaceSlug)
  );
}

export function isManagedFactoryPath(pathname: string, workspaceSlug: string) {
  return (
    pathname === workspaceGovernancePath(workspaceSlug) ||
    pathname === workspaceContextPath(workspaceSlug) ||
    pathname === workspaceMemoryPath(workspaceSlug)
  );
}

export function isFactoryOutcomePath(pathname: string, workspaceSlug: string) {
  return (
    pathname === workspaceAnalyticsPath(workspaceSlug) ||
    pathname === workspaceOverviewPath(workspaceSlug)
  );
}

export function isFactorySelectorPath(pathname: string, workspaceSlug: string) {
  return (
    isFactoryAggregatePath(pathname, workspaceSlug) ||
    pathname === workspaceAgentsPath(workspaceSlug) ||
    pathname === workspaceScorersPath(workspaceSlug) ||
    isFactoryOutcomePath(pathname, workspaceSlug) ||
    isManagedFactoryPath(pathname, workspaceSlug)
  );
}

export function withFactoryQuery(
  href: string,
  value: string | readonly string[] | null | undefined,
) {
  if (value == null) return href;
  const values = typeof value === "string" ? [value] : value;
  if (values.length === 0) return href;
  const url = new URL(href, "http://localhost");
  url.searchParams.delete(FACTORY_QUERY_PARAM);
  for (const entry of values) url.searchParams.append(FACTORY_QUERY_PARAM, entry);
  return url.pathname + url.search + url.hash;
}

export function factorySwitchHref(pathname: string, search: string, value: string) {
  const params = new URLSearchParams(search);
  for (const key of ["cursor", "stage", "stageId", "sessionId", "create", "after"])
    params.delete(key);
  if (pathname.endsWith("/analytics") || pathname.endsWith("/overview")) {
    for (const key of ["metric", "period", "facet", "bucket"]) params.delete(key);
  }
  if (pathname.endsWith("/analytics")) {
    for (const key of [
      "scorerRevision",
      "cohort",
      "scoreSnapshot",
      "evaluationDay",
      "evaluationStatus",
      "beforeRunFinishedAt",
      "beforeScoreRun",
    ])
      params.delete(key);
  }
  if (pathname.endsWith("/scorers")) params.delete("revision");
  if (pathname.endsWith("/governance")) {
    for (const key of [
      "principal",
      "grant",
      "binding",
      "mcpBinding",
      "event",
      "actor",
      "afterGrant",
      "afterPrincipal",
      "afterBinding",
      "beforeAudit",
    ])
      params.delete(key);
  }
  if (pathname.endsWith("/context") || pathname.endsWith("/memory")) {
    for (const key of [
      "source",
      "revision",
      "memory",
      "decision",
      "proposal",
      "version",
      "before",
      "grantAfter",
      "repoAfter",
    ])
      params.delete(key);
  }
  params.set(FACTORY_QUERY_PARAM, value);
  return `${pathname}?${params}`;
}
