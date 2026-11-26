import { resolveAppOrigin } from "@/lib/app-url";
import { parseFactoryMcpResource } from "@/lib/factory-mcp/resource";
import { parseFactoryOAuthAuthorization } from "@/lib/factory-oauth/protocol";
import { loginPath } from "@/lib/routes";

const authorizePath = "/oauth/authorize";
type AuthorizationRequest = Extract<
  ReturnType<typeof parseFactoryOAuthAuthorization>,
  { ok: true }
>["request"];

export function consentResumePath(request: AuthorizationRequest) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: request.clientId,
    redirect_uri: request.redirectUri,
    scope: request.scopes.join(" "),
    code_challenge: request.challenge,
    code_challenge_method: "S256",
  });
  if (request.state !== undefined) params.set("state", request.state);
  if (request.resource !== undefined) {
    params.set("resource", parseFactoryMcpResource(request.resource)?.resource ?? "");
  }
  return `${authorizePath}?${params}`;
}

export function consentDecisionRecovery(request: Request, status: number) {
  const acceptsHtml = request.headers
    .get("accept")
    ?.split(",")
    .some((value) => value.trim().split(";")[0] === "text/html");
  if (!acceptsHtml) return null;

  if (status === 401) {
    const referer = request.headers.get("referer");
    const previous = referer ? URL.parse(referer) : null;
    if (previous?.origin === resolveAppOrigin() && previous.pathname === authorizePath) {
      const parsed = parseFactoryOAuthAuthorization(previous.searchParams);
      if (parsed.ok) return loginPath(consentResumePath(parsed.request));
    }
  }

  return `${authorizePath}/recover?reason=${status === 401 ? "signed_out" : "unavailable"}`;
}
