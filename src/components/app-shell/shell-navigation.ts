import { workspaceBasePath, workspaceSessionsPath } from "@/lib/routes";

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
