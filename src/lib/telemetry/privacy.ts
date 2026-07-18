export type SafeRouteTemplate =
  | "/"
  | "/_not-found"
  | "/login"
  | "/onboarding/workspace"
  | "/redacted"
  | "/signup"
  | "/w/[workspaceSlug]"
  | "/w/[workspaceSlug]/onboarding"
  | "/w/[workspaceSlug]/pipeline"
  | "/w/[workspaceSlug]/sessions"
  | "/w/[workspaceSlug]/sessions/[sessionNumber]"
  | "/w/[workspaceSlug]/settings";

export function routeTemplateForPath(pathname: string): SafeRouteTemplate {
  if (pathname === "/") return "/";
  if (["/_not-found", "/login", "/signup", "/onboarding/workspace"].includes(pathname)) {
    return pathname as SafeRouteTemplate;
  }

  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "w" || segments.length < 2) return "/redacted";
  if (segments.length === 2) return "/w/[workspaceSlug]";
  if (
    segments.length === 3 &&
    ["onboarding", "pipeline", "sessions", "settings"].includes(segments[2]!)
  ) {
    return `/w/[workspaceSlug]/${segments[2]}` as SafeRouteTemplate;
  }
  if (segments.length === 4 && segments[2] === "sessions") {
    return "/w/[workspaceSlug]/sessions/[sessionNumber]";
  }
  return "/redacted";
}

export function sanitizeTelemetryUrl(value: string) {
  try {
    const url = new URL(value, "https://wallie.invalid");
    return `${url.origin}${routeTemplateForPath(url.pathname)}`;
  } catch {
    return "https://wallie.invalid/redacted";
  }
}
