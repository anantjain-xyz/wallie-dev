import { workspaceBasePath, workspaceRunsPath, workspaceSessionsPath } from "@/lib/routes";

export const FACTORY_QUERY_PARAM = "factory";

export type FactorySelectionOption = {
  id: string;
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

  const match =
    value == null
      ? factories.find((factory) => factory.isDefault)
      : factories.find((factory) => factory.id === value);
  return match ? { kind: "factory", factory: match } : { kind: "unavailable" };
}

export function isFactoryAggregatePath(pathname: string, workspaceSlug: string) {
  return (
    pathname === workspaceBasePath(workspaceSlug) ||
    pathname === workspaceSessionsPath(workspaceSlug) ||
    pathname === workspaceRunsPath(workspaceSlug)
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
  for (const key of ["cursor", "stage", "stageId", "sessionId", "create"]) params.delete(key);
  params.set(FACTORY_QUERY_PARAM, value);
  return `${pathname}?${params}`;
}
