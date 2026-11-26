import {
  defaultsToAllFactories,
  isFactoryAggregatePath,
  isManagedFactoryPath,
  resolveFactorySelection,
  withFactoryQuery,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";
import { workspaceBasePath, workspaceSessionsPath, type WorkspaceNavItem } from "@/lib/routes";

type FactoryPolicy = "aggregate" | "default" | "visible" | "managed" | "active" | "active-managed";
type ShellFactoryScope =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "factory"; factory: FactorySelectionOption; explicit: boolean }
  | { kind: "unavailable"; query: readonly string[] };

const singleFactoryPolicies: Partial<Record<WorkspaceNavItem["id"], FactoryPolicy>> = {
  agents: "default",
  overview: "visible",
  analytics: "visible",
  benchmarks: "visible",
  "failure-groups": "visible",
  improvements: "visible",
  scorers: "visible",
  "factory-definition": "active",
  workflows: "active-managed",
  automations: "active-managed",
};

function policyFor(item: WorkspaceNavItem, slug: string) {
  if (isFactoryAggregatePath(item.href, slug)) return "aggregate";
  return (
    singleFactoryPolicies[item.id] ??
    (isManagedFactoryPath(item.href, slug) ? "managed" : undefined)
  );
}

function eligibleFactories(factories: readonly FactorySelectionOption[], policy: FactoryPolicy) {
  if (policy === "active-managed")
    return factories.filter(({ canManage, status }) => canManage && status === "active");
  if (policy === "active") return factories.filter(({ status }) => status === "active");
  if (policy === "managed") return factories.filter(({ canManage }) => canManage);
  return factories;
}

function implicitFactory(factories: readonly FactorySelectionOption[], policy: FactoryPolicy) {
  const selection = resolveFactorySelection(eligibleFactories(factories, policy), undefined, {
    useFirstVisible: policy !== "aggregate" && policy !== "default" && policy !== "active",
  });
  return selection.kind === "factory" ? selection.factory : null;
}

export function shellFactoryScope({
  factories,
  item,
  pathname,
  query,
  slug,
}: {
  factories: readonly FactorySelectionOption[];
  item: WorkspaceNavItem | undefined;
  pathname: string;
  query: string[];
  slug: string;
}): ShellFactoryScope {
  const policy = item && policyFor(item, slug);
  if (query.length > 0) {
    const selection = resolveFactorySelection(
      policy ? eligibleFactories(factories, policy) : factories,
      query.length === 1 ? query[0] : query,
    );
    if (selection.kind === "all" && (!policy || policy === "aggregate")) return selection;
    if (selection.kind === "factory") return { ...selection, explicit: true };
    const canResolveElsewhere =
      selection.kind === "all" ||
      (query.length === 1 && factories.some(({ id }) => id === query[0].toLowerCase()));
    return { kind: "unavailable", query: canResolveElsewhere ? [] : query };
  }
  if (!policy || (policy === "aggregate" && item?.href !== pathname)) return { kind: "none" };
  if (defaultsToAllFactories(pathname, slug)) return { kind: "all" };
  const factory = implicitFactory(factories, policy);
  return factory
    ? { kind: "factory", factory, explicit: false }
    : { kind: "unavailable", query: [] };
}

export function shellNavDestination(
  item: WorkspaceNavItem,
  slug: string,
  factories: readonly FactorySelectionOption[],
  scope: ShellFactoryScope,
) {
  const policy = policyFor(item, slug);
  if (!policy || scope.kind === "none") return { href: item.href };
  const fallback = implicitFactory(factories, policy);
  if (scope.kind === "unavailable") {
    const query = scope.query.length
      ? scope.query
      : fallback || defaultsToAllFactories(item.href, slug)
        ? "unavailable"
        : undefined;
    return { href: withFactoryQuery(item.href, query) };
  }
  if (scope.kind === "all" && policy === "aggregate") {
    return { href: withFactoryQuery(item.href, "all") };
  }
  if (
    scope.kind === "factory" &&
    eligibleFactories(factories, policy).some(({ id }) => id === scope.factory.id)
  ) {
    const sameImplicitScope =
      !scope.explicit &&
      fallback?.id === scope.factory.id &&
      !defaultsToAllFactories(item.href, slug);
    return { href: withFactoryQuery(item.href, sameImplicitScope ? undefined : scope.factory.id) };
  }

  return {
    href: withFactoryQuery(item.href, fallback?.id),
    scopeNote: fallback ? `Opens in ${fallback.name}` : "Requires a factory",
  };
}

const RETURN_TO_PARAM = "returnTo";
const WORKFLOW_ACTIVATION_PARAM = "workflowActivation";
const URL_BASE = "https://wallie.invalid";

export function readSessionLaunchActivation(params: Pick<URLSearchParams, "getAll"> | null) {
  const values = params?.getAll(WORKFLOW_ACTIVATION_PARAM) ?? [];
  if (!values.length) return undefined;
  const id = values[0];
  return values.length === 1 && id && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id)
    ? id.toLowerCase()
    : null;
}

export function withoutSessionLaunch(pathname: string, search: string, hash = "") {
  const params = new URLSearchParams(search);
  params.delete("create");
  params.delete(RETURN_TO_PARAM);
  params.delete(WORKFLOW_ACTIVATION_PARAM);
  return `${pathname}${params.size ? `?${params}` : ""}${hash}`;
}

export function resolveSessionReturnTo(value: string | null, slug: string) {
  if (!value?.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  let url: URL;
  try {
    url = new URL(value, URL_BASE);
  } catch {
    return null;
  }
  const base = workspaceBasePath(slug);
  if (
    url.origin !== URL_BASE ||
    /%(?:2f|5c)/iu.test(url.pathname) ||
    (url.pathname !== base && !url.pathname.startsWith(`${base}/`))
  ) {
    return null;
  }
  return withoutSessionLaunch(url.pathname, url.search, url.hash);
}

export function sessionLaunchHref(
  slug: string,
  factoryId: string,
  returnTo?: string,
  workflowActivationId?: string,
) {
  return workspaceSessionsPath(slug, {
    factory: factoryId,
    create: 1,
    [RETURN_TO_PARAM]: resolveSessionReturnTo(returnTo ?? null, slug) ?? undefined,
    [WORKFLOW_ACTIVATION_PARAM]: workflowActivationId,
  });
}
