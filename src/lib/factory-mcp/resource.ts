import { z } from "zod";

import { resolveAppOrigin } from "@/lib/app-url";
import { factoryCommandScopeSchema } from "@/lib/factory-machine-tokens/contracts";

export const factoryMcpScopeSchema = z.strictObject({
  workspaceId: z.string().uuid().toLowerCase(),
  factoryId: z.string().uuid().toLowerCase(),
});

export type FactoryMcpScope = z.output<typeof factoryMcpScopeSchema>;

const resourcePath = /^\/api\/v1\/workspaces\/([^/]+)\/factories\/([^/]+)\/mcp$/;
const protectedResourcePrefix = "/.well-known/oauth-protected-resource";
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const factoryMcpDiscoveryScope = "sessions:read";

function configuredIssuer() {
  try {
    const issuer = URL.parse(resolveAppOrigin());
    if (
      issuer?.protocol === "https:" ||
      (issuer?.protocol === "http:" && loopbackHosts.has(issuer.hostname))
    ) {
      return issuer.origin;
    }
  } catch {
    // Invalid deployment configuration cannot advertise an OAuth issuer.
  }
  return null;
}

export function factoryMcpResource({ workspaceId, factoryId }: FactoryMcpScope) {
  const issuer = configuredIssuer();
  if (!issuer) return null;
  return new URL(
    `/api/v1/workspaces/${workspaceId.toLowerCase()}/factories/${factoryId.toLowerCase()}/mcp`,
    issuer,
  );
}

export function parseFactoryMcpResource(
  value: string,
): (FactoryMcpScope & { resource: string }) | null {
  const url = URL.parse(value);
  if (!url) return null;
  const match = resourcePath.exec(url.pathname);
  if (!match) return null;
  const scope = factoryMcpScopeSchema.safeParse({ workspaceId: match[1], factoryId: match[2] });
  if (!scope.success) return null;
  const resource = factoryMcpResource(scope.data)?.href;
  return resource === value ? { ...scope.data, resource } : null;
}

export function factoryMcpProtectedResourceMetadataUrl(resource: URL) {
  return new URL(protectedResourcePrefix + resource.pathname, resource.origin);
}

export function factoryMcpProtectedResourceMetadata(resource: URL) {
  return {
    resource: resource.href,
    resource_name: "Wallie Factory MCP",
    authorization_servers: [resource.origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [factoryMcpDiscoveryScope],
  };
}

export function factoryOAuthAuthorizationServerMetadata() {
  const issuer = configuredIssuer();
  if (!issuer) return null;
  return {
    issuer,
    authorization_endpoint: new URL("/oauth/authorize", issuer).href,
    token_endpoint: new URL("/oauth/token", issuer).href,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: factoryCommandScopeSchema.options,
  };
}
