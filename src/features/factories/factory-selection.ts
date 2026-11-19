import {
  workspaceActivityPath,
  workspaceAgentsPath,
  workspaceBasePath,
  workspaceGovernancePath,
  workspaceInboxPath,
  workspaceRunsPath,
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

export function isFactorySelectorPath(pathname: string, workspaceSlug: string) {
  return (
    isFactoryAggregatePath(pathname, workspaceSlug) ||
    pathname === workspaceAgentsPath(workspaceSlug) ||
    pathname === workspaceGovernancePath(workspaceSlug)
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
  params.set(FACTORY_QUERY_PARAM, value);
  return `${pathname}?${params}`;
}
