import { fromJsonSchema, requireScopes } from "@modelcontextprotocol/server";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { GET as authorizationMetadata } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as protectedResourceMetadata } from "@/app/.well-known/oauth-protected-resource/api/v1/workspaces/[workspaceId]/factories/[factoryId]/mcp/route";
import { issueFactoryMachineTokenSecret } from "@/lib/factory-machine-tokens/secret";
import { issueFactoryOAuthCredential } from "@/lib/factory-oauth/credentials";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import {
  factoryMcpProtectedResourceMetadataUrl,
  factoryMcpResource,
  parseFactoryMcpResource,
} from "./resource";
import { handleFactoryMcp, type FactoryMcpHttpFailure } from "./server";
import { registerFactoryMcpTools } from "./tools";

vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("./tools", () => ({ registerFactoryMcpTools: vi.fn() }));

const origin = "https://factory.example";
const factory = {
  workspaceId: "441fc1cb-6be5-42a9-959e-d67a8aec04ff",
  factoryId: "df68f791-a33b-4078-bf73-d460fd547c3a",
};
const machine = issueFactoryMachineTokenSecret();
const oauth = issueFactoryOAuthCredential("access");
const modernVersion = "2026-07-28";
const legacyVersion = "2025-11-25";
const inspect = vi.fn();
const runTool = vi.fn();

function configuredResource() {
  const resource = factoryMcpResource(factory);
  if (!resource) throw new Error("Expected a configured MCP scope.");
  return resource;
}

function issuerDiscovery(origin: string) {
  return authorizationMetadata(new Request(`${origin}/.well-known/oauth-authorization-server`));
}

function request(body: unknown, extra?: Record<string, string>) {
  const url = configuredResource();
  return new Request(url, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Host: url.host,
      Authorization: `Bearer ${machine.credential}`,
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

function modernRequest(
  method: string,
  params?: Record<string, unknown>,
  extra?: Record<string, string>,
) {
  return request(
    {
      jsonrpc: "2.0",
      id: 7,
      method,
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": modernVersion,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "wire-fixture", version: "1.0.0" },
        },
        ...params,
      },
    },
    { "MCP-Protocol-Version": modernVersion, "Mcp-Method": method, ...extra },
  );
}

function toolRequest(version: string) {
  const params = { name: "wallie_fixture_read", arguments: {} };
  return version === modernVersion
    ? modernRequest("tools/call", params, { "Mcp-Name": params.name })
    : request(
        { jsonrpc: "2.0", id: 6, method: "tools/call", params },
        {
          "MCP-Protocol-Version": legacyVersion,
        },
      );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", origin);
  inspect.mockResolvedValue({ status: "authorized", scopes: ["sessions:read"] });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe("/rest/v1/rpc/inspect_factory_mcp_identity");
    if (typeof init?.body !== "string") throw new Error("No identity inspection arguments.");
    return Response.json(await inspect(JSON.parse(init.body)));
  };
  const admin = createClient<Database>("https://db.example", "synthetic-key", {
    global: { fetch },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  vi.mocked(createSupabaseAdminClient).mockReturnValue(admin);
  vi.mocked(registerFactoryMcpTools).mockImplementation((server, context) => {
    server.registerTool(
      "wallie_fixture_read",
      {
        inputSchema: fromJsonSchema({ type: "object", additionalProperties: false }),
        scopeChallenge: requireScopes("sessions:read"),
      },
      async () => {
        const denial: FactoryMcpHttpFailure | undefined = await runTool(context);
        if (denial) context.reportHttpFailure(denial);
        return {
          content: [{ type: "text", text: "Fixture session" }],
          structuredContent: { session: "fixture" },
        };
      },
    );
  });
});

afterEach(() => vi.unstubAllEnvs());

it("publishes exact protected resource discovery and the existing OAuth issuer", async () => {
  const resource = configuredResource();
  expect(parseFactoryMcpResource(resource.href)).toEqual({ ...factory, resource: resource.href });
  for (const alternative of [
    `${resource.href}/`,
    `${resource.href}?scope=sessions:read`,
    `${resource.href}#mcp`,
    resource.href.replace("factory.example", "elsewhere.example"),
  ]) {
    expect(parseFactoryMcpResource(alternative)).toBeNull();
  }

  const unauthenticated = new Request(resource, {
    method: "POST",
    headers: { Host: resource.host },
  });
  const challenge = await handleFactoryMcp(unauthenticated, factory);
  expect(challenge.status).toBe(401);
  const metadataUrl = factoryMcpProtectedResourceMetadataUrl(resource);
  expect(challenge.headers.get("WWW-Authenticate")).toBe(
    `Bearer resource_metadata="${metadataUrl.href}", scope="sessions:read"`,
  );
  expect(createSupabaseAdminClient).not.toHaveBeenCalled();

  const metadata = await protectedResourceMetadata(new Request(metadataUrl), {
    params: Promise.resolve(factory),
  });
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toEqual({
    resource: resource.href,
    resource_name: "Wallie Factory MCP",
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: ["sessions:read"],
  });
  expect(await issuerDiscovery(origin).json()).toMatchObject({
    issuer: origin,
    token_endpoint: `${origin}/oauth/token`,
    authorization_endpoint: `${origin}/oauth/authorize`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: expect.arrayContaining(["sessions:create", "sessions:cancel"]),
  });
});

it("rejects scheme downgrade even when the hostname and bearer match the HTTPS resource", async () => {
  const downgraded = new URL(configuredResource());
  downgraded.protocol = "http:";
  const response = await handleFactoryMcp(
    new Request(downgraded, {
      method: "POST",
      headers: { Host: downgraded.host, Authorization: `Bearer ${machine.credential}` },
    }),
    factory,
  );
  expect(response.status).toBe(403);
  expect(response.headers.has("WWW-Authenticate")).toBe(false);
  expect(inspect).not.toHaveBeenCalled();
  const metadata = factoryMcpProtectedResourceMetadataUrl(downgraded);
  expect(
    (await protectedResourceMetadata(new Request(metadata), { params: Promise.resolve(factory) }))
      .status,
  ).toBe(404);
  expect(issuerDiscovery(downgraded.origin).status).toBe(404);
});

it("only advertises a cleartext issuer and resource on loopback", async () => {
  const insecure = new URL(configuredResource());
  insecure.protocol = "http:";
  vi.stubEnv("NEXT_PUBLIC_APP_URL", insecure.origin);
  expect(factoryMcpResource(factory)).toBeNull();
  expect(parseFactoryMcpResource(insecure.href)).toBeNull();
  expect(issuerDiscovery(insecure.origin).status).toBe(503);
  const metadata = factoryMcpProtectedResourceMetadataUrl(insecure);
  expect(
    (await protectedResourceMetadata(new Request(metadata), { params: Promise.resolve(factory) }))
      .status,
  ).toBe(503);
  const unavailable = await handleFactoryMcp(
    new Request(insecure, {
      method: "POST",
      headers: { Host: insecure.host, Authorization: `Bearer ${machine.credential}` },
    }),
    factory,
  );
  expect(unavailable.status).toBe(503);
  expect(inspect).not.toHaveBeenCalled();

  const local = "http://localhost:59022";
  vi.stubEnv("NEXT_PUBLIC_APP_URL", local);
  const expected = configuredResource();
  expect(expected.origin).toBe(local);
  expect(parseFactoryMcpResource(expected.href)).toEqual({ ...factory, resource: expected.href });
  expect(issuerDiscovery(local).status).toBe(200);
  const qualified = await handleFactoryMcp(
    modernRequest("tools/list", {}, { Origin: local }),
    factory,
  );
  expect(qualified.status).toBe(200);
});

it("serves modern discovery and tools without an initialization exchange", async () => {
  const discovery = await handleFactoryMcp(modernRequest("server/discover"), factory);
  expect(discovery.status).toBe(200);
  expect(discovery.headers.get("Cache-Control")).toBe("private, no-store");
  expect(discovery.headers.has("Mcp-Session-Id")).toBe(false);
  const discovered = await discovery.text();
  expect(discovered).not.toContain(machine.credential);
  expect(JSON.parse(discovered)).toMatchObject({
    jsonrpc: "2.0",
    id: 7,
    result: { supportedVersions: [modernVersion], capabilities: { tools: { listChanged: false } } },
  });
  expect(inspect).toHaveBeenCalledExactlyOnceWith({
    p_workspace_id: factory.workspaceId,
    p_factory_id: factory.factoryId,
    p_credential_kind: "machine_token",
    p_credential_id: machine.tokenId,
    p_credential_digest: machine.digest,
    p_resource: configuredResource().href,
  });

  const list = await handleFactoryMcp(modernRequest("tools/list"), factory);
  expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({
    result: { tools: [{ name: "wallie_fixture_read" }] },
  });
  expect(runTool).not.toHaveBeenCalled();
  const tool = await handleFactoryMcp(toolRequest(modernVersion), factory);
  expect(tool.status).toBe(200);
  expect(await tool.json()).toMatchObject({
    id: 7,
    result: { resultType: "complete", structuredContent: { session: "fixture" } },
  });
  expect(runTool).toHaveBeenCalledOnce();
});

it("supports legacy initialization, notifications, and tool calls on the same URL", async () => {
  const initialization = await handleFactoryMcp(
    request({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: legacyVersion,
        clientInfo: { name: "legacy-fixture", version: "1.0.0" },
        capabilities: {},
      },
    }),
    factory,
  );
  expect(initialization.status).toBe(200);
  expect(await initialization.json()).toMatchObject({
    id: "init",
    result: { protocolVersion: legacyVersion },
  });
  expect(initialization.headers.has("Mcp-Session-Id")).toBe(false);
  const initialized = await handleFactoryMcp(
    request(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      {
        "MCP-Protocol-Version": legacyVersion,
      },
    ),
    factory,
  );
  expect(initialized.status).toBe(202);
  expect(await initialized.text()).toBe("");
  expect(runTool).not.toHaveBeenCalled();
  const tool = await handleFactoryMcp(toolRequest(legacyVersion), factory);
  expect(tool.status).toBe(200);
  expect(await tool.json()).toMatchObject({
    id: 6,
    result: { structuredContent: { session: "fixture" } },
  });
});

it.each([modernVersion, legacyVersion])(
  "challenges the exact tool scope before running %s",
  async (version) => {
    inspect.mockResolvedValueOnce({ status: "authorized", scopes: ["sessions:create"] });
    const response = await handleFactoryMcp(toolRequest(version), factory);
    expect(response.status).toBe(403);
    const challenge = response.headers.get("WWW-Authenticate");
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="sessions:read"');
    expect(challenge).toContain(
      `resource_metadata="${factoryMcpProtectedResourceMetadataUrl(configuredResource()).href}"`,
    );
    expect(runTool).not.toHaveBeenCalled();
  },
);

it.each([modernVersion, legacyVersion])(
  "reports late authorization and quotas as HTTP failures in %s",
  async (version) => {
    runTool.mockResolvedValueOnce({ status: 401, code: "unauthorized", scope: "sessions:read" });
    const revoked = await handleFactoryMcp(toolRequest(version), factory);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect(await revoked.json()).toEqual({ code: "unauthorized" });
    runTool.mockResolvedValueOnce({
      status: 429,
      code: "concurrency_limited",
      scope: "sessions:read",
      retryAfterSeconds: 3,
    });
    const quota = await handleFactoryMcp(toolRequest(version), factory);
    expect(quota.status).toBe(429);
    expect(quota.headers.get("Retry-After")).toBe("3");
    expect(await quota.json()).toEqual({ code: "concurrency_limited", retryAfterSeconds: 3 });
  },
);

it("refuses exact-origin mismatch, query credentials, revoked OAuth, and unneeded methods", async () => {
  const maliciousOrigin = await handleFactoryMcp(
    modernRequest("tools/list", {}, { Origin: "https://other.example" }),
    factory,
  );
  expect(maliciousOrigin.status).toBe(403);
  const maliciousHost = await handleFactoryMcp(
    modernRequest("tools/list", {}, { Host: "other.example" }),
    factory,
  );
  expect(maliciousHost.status).toBe(403);
  const url = configuredResource();
  const query = await handleFactoryMcp(
    new Request(`${url.href}?access_token=dummy`, {
      method: "POST",
      headers: { Host: url.host },
    }),
    factory,
  );
  expect(query.status).toBe(404);
  expect(inspect).not.toHaveBeenCalled();

  inspect.mockResolvedValueOnce({ status: "unauthorized", scopes: [] });
  const revoked = await handleFactoryMcp(
    modernRequest("tools/list", {}, { Authorization: `Bearer ${oauth.credential}` }),
    factory,
  );
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
  expect(inspect).toHaveBeenCalledWith(
    expect.objectContaining({
      p_credential_kind: "oauth_access_token",
      p_credential_id: oauth.id,
      p_credential_digest: oauth.digest,
      p_resource: url.href,
    }),
  );
  const get = await handleFactoryMcp(
    new Request(url, {
      headers: {
        Host: url.host,
        Authorization: `Bearer ${machine.credential}`,
      },
    }),
    factory,
  );
  expect(get.status).toBe(405);
  expect(get.headers.get("Allow")).toBe("POST");
  expect(runTool).not.toHaveBeenCalled();
});

it("rejects malformed protocol headers, batches, and oversized bodies before tool execution", async () => {
  const mismatch = await handleFactoryMcp(
    modernRequest("tools/list", {}, { "Mcp-Method": "tools/call" }),
    factory,
  );
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({ id: 7, error: { code: -32020 } });
  const batch = await handleFactoryMcp(
    request([{ jsonrpc: "2.0", id: 9, method: "tools/list" }]),
    factory,
  );
  expect(batch.status).toBe(400);
  const large = await handleFactoryMcp(
    modernRequest("tools/list", { oversized: "x".repeat(280_000) }),
    factory,
  );
  expect(large.status).toBe(413);
  expect(runTool).not.toHaveBeenCalled();
});
