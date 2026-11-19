import "server-only";

import {
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  McpServer,
  readRequestBody,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { parseFactoryCommandCredential } from "@/lib/factory-command-authorization/server";
import {
  factoryCommandScopeSchema,
  factoryCommandScopesSchema,
} from "@/lib/factory-machine-tokens/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import {
  factoryMcpDiscoveryScope,
  factoryMcpProtectedResourceMetadataUrl,
  factoryMcpResource,
  factoryMcpScopeSchema,
  type FactoryMcpScope,
} from "./resource";
import { registerFactoryMcpTools } from "./tools";

const modernProtocol = "2026-07-28";
const legacyProtocol = "2025-11-25";
const maxRequestBodySize = 272 * 1024;
const protectedHeaders = { "Cache-Control": "private, no-store" };

type FactoryCommandScope = z.output<typeof factoryCommandScopeSchema>;
export type FactoryMcpHttpFailure = {
  scope: FactoryCommandScope;
} & (
  | { status: 401; code: "unauthorized" }
  | { status: 403; code: "forbidden" }
  | { status: 429; code: "rate_limited" | "concurrency_limited"; retryAfterSeconds: number }
);

export type FactoryMcpToolContext = FactoryMcpScope & {
  authorization: string;
  resource: string;
  signal: AbortSignal;
  reportHttpFailure: (failure: FactoryMcpHttpFailure) => void;
};

const identitySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authorized"),
    scopes: factoryCommandScopesSchema.refine((scopes) => scopes.length > 0),
  }),
  z.object({ status: z.enum(["unauthorized", "forbidden"]) }),
]);

function stableError(status: number, code: string, headers?: Record<string, string>) {
  return Response.json({ code }, { status, headers: { ...protectedHeaders, ...headers } });
}

function protocolError(status: number, code: number, message: string) {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers: protectedHeaders },
  );
}

function credentialChallenge({
  status,
  code,
  metadataUrl,
  scope,
  presented,
}: {
  status: 401 | 403;
  code: "unauthorized" | "forbidden";
  metadataUrl: string;
  scope: FactoryCommandScope;
  presented: boolean;
}) {
  const challenge = [`resource_metadata="${metadataUrl}"`, `scope="${scope}"`];
  if (status === 403) challenge.push('error="insufficient_scope"');
  else if (presented) challenge.push('error="invalid_token"');
  return stableError(status, code, { "WWW-Authenticate": `Bearer ${challenge.join(", ")}` });
}

async function inspectIdentity({
  authorization,
  scope,
  resource,
  metadataUrl,
  signal,
}: {
  authorization: string | null;
  scope: FactoryMcpScope;
  resource: URL;
  metadataUrl: string;
  signal: AbortSignal;
}): Promise<AuthInfo | Response> {
  const challenge = (status: 401 | 403, code: "unauthorized" | "forbidden") =>
    credentialChallenge({
      status,
      code,
      metadataUrl,
      scope: factoryMcpDiscoveryScope,
      presented: authorization !== null,
    });
  const credential = parseFactoryCommandCredential(authorization);
  if (!credential || !authorization) return challenge(401, "unauthorized");

  try {
    const { data, error } = await createSupabaseAdminClient()
      .rpc("inspect_factory_mcp_identity", {
        p_workspace_id: scope.workspaceId,
        p_factory_id: scope.factoryId,
        p_credential_kind: credential.kind,
        p_credential_id: credential.id,
        p_credential_digest: credential.digest,
        p_resource: resource.href,
      })
      .abortSignal(signal)
      .single();
    if (error) return stableError(503, "unavailable");
    const identity = identitySchema.safeParse(data);
    if (!identity.success) return stableError(503, "unavailable");
    if (identity.data.status !== "authorized") {
      return identity.data.status === "unauthorized"
        ? challenge(401, "unauthorized")
        : challenge(403, "forbidden");
    }
    return {
      token: authorization.slice("Bearer ".length),
      clientId: credential.id,
      scopes: identity.data.scopes,
      resource,
      resourceMetadataUrl: metadataUrl,
    };
  } catch {
    return stableError(503, "unavailable");
  }
}

function createServer(context: FactoryMcpToolContext) {
  const server = new McpServer(
    { name: "wallie-factory", version: "1.0.0" },
    {
      capabilities: { tools: { listChanged: false } },
      supportedProtocolVersions: [modernProtocol, legacyProtocol],
    },
  );
  registerFactoryMcpTools(server, context);
  return server;
}

async function sdkResponse(
  request: Request,
  parsedBody: unknown,
  authInfo: AuthInfo,
  context: FactoryMcpToolContext,
) {
  if (await isLegacyRequest(request, parsedBody)) {
    const server = createServer(context);
    // Both revisions finish the tool before HTTP response headers. The same
    // transaction can therefore surface a late authorization or quota decision.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request, { authInfo, parsedBody });
    } finally {
      await server.close();
    }
  }

  const handler = createMcpHandler(() => createServer(context), {
    legacy: "reject",
    maxRequestBodySize,
    maxSubscriptions: 0,
  });
  try {
    return await handler.fetch(request, { authInfo, parsedBody });
  } finally {
    await handler.close();
  }
}

export async function handleFactoryMcp(request: Request, rawScope: unknown) {
  const scope = factoryMcpScopeSchema.safeParse(rawScope);
  if (!scope.success) return stableError(404, "not_found");
  const resource = factoryMcpResource(scope.data);
  if (!resource) return stableError(503, "unavailable");
  const url = new URL(request.url);
  if (url.pathname !== resource.pathname || request.url.includes("?")) {
    return stableError(404, "not_found");
  }
  const origin = request.headers.get("Origin");
  if (
    request.headers.get("Host")?.toLowerCase() !== resource.host ||
    url.origin !== resource.origin ||
    (origin !== null && origin !== resource.origin)
  ) {
    return stableError(403, "forbidden");
  }

  const authorization = request.headers.get("Authorization");
  const metadataUrl = factoryMcpProtectedResourceMetadataUrl(resource).href;
  const authInfo = await inspectIdentity({
    authorization,
    scope: scope.data,
    resource,
    metadataUrl,
    signal: request.signal,
  });
  if (authInfo instanceof Response) return authInfo;
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...protectedHeaders, Allow: "POST" } });
  }
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return protocolError(415, -32000, "Content-Type must be application/json");
  }

  let parsedBody: unknown;
  try {
    const body = await readRequestBody(request, maxRequestBodySize);
    if (body.tooLarge) return protocolError(413, -32000, "Request body is too large");
    parsedBody = JSON.parse(body.text);
  } catch {
    return protocolError(400, -32700, "Invalid JSON");
  }
  if (Array.isArray(parsedBody)) return protocolError(400, -32600, "Expected one JSON-RPC message");

  const reported: { failure?: FactoryMcpHttpFailure } = {};
  try {
    const response = await sdkResponse(request, parsedBody, authInfo, {
      ...scope.data,
      authorization: `Bearer ${authInfo.token}`,
      resource: resource.href,
      signal: request.signal,
      reportHttpFailure: (failure) => {
        reported.failure = failure;
      },
    });
    const { failure } = reported;
    if (failure?.status === 429) {
      return Response.json(
        { code: failure.code, retryAfterSeconds: failure.retryAfterSeconds },
        {
          status: 429,
          headers: { ...protectedHeaders, "Retry-After": String(failure.retryAfterSeconds) },
        },
      );
    }
    if (failure) {
      return credentialChallenge({ ...failure, metadataUrl, presented: true });
    }
    response.headers.set("Cache-Control", protectedHeaders["Cache-Control"]);
    return response;
  } catch {
    return protocolError(500, -32603, "Internal server error");
  }
}
