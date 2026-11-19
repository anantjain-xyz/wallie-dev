import { expect, it } from "vitest";

import {
  factoryMcpFixture,
  FactoryClient,
  type FactoryBody,
} from "../../../e2e/helpers/factory-integration";

const options = {
  baseUrl: "http://localhost:59043",
  workspaceId: "441fc1cb-6be5-42a9-959e-d67a8aec04ff",
  factoryId: "df68f791-a33b-4078-bf73-d460fd547c3a",
  token: "fixture-bearer",
};
const factoryPath = `/api/v1/workspaces/${options.workspaceId}/factories/${options.factoryId}`;

it("sends the same create intent and idempotency key through the SDK and modern MCP", async () => {
  const body: FactoryBody<"createFactorySession"> = {
    title: "Cross-interface fixture",
    prompt: "Draft the change in Wallie.",
    agentId: "232534a9-829e-40cf-a961-87ab20000e88",
    repositoryId: "49092451-8281-4c37-a854-1c210a2c7a36",
    draftSpecification: true,
  };
  const idempotencyKey = "61517af1-2237-494b-a6fa-47f7b541a509";
  const receipt = { sessionId: "7fc42ec1-119d-4d26-82f0-976bf7d928fb" };
  const wire: {
    url: string;
    headers: Headers;
    method?: string;
    redirect?: string;
    data: unknown;
  }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    wire.push({
      url: url.href,
      headers: new Headers(init?.headers),
      method: init?.method,
      redirect: init?.redirect,
      data: JSON.parse(String(init?.body)),
    });
    if (url.pathname.endsWith("/sessions")) return Response.json(receipt, { status: 201 });
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "complete", structuredContent: { ...receipt, replayed: true } },
    });
  };
  const api = new FactoryClient({ ...options, fetch });
  const mcp = factoryMcpFixture({ ...options, fetch });

  expect(await api.createSession(body, { idempotencyKey })).toEqual(receipt);
  expect(await mcp.call("wallie_create_session", { ...body, idempotencyKey })).toEqual({
    ok: true,
    status: 200,
    result: { ...receipt, replayed: true },
  });
  expect(wire).toHaveLength(2);
  expect(wire[0]).toMatchObject({
    url: `${options.baseUrl}${factoryPath}/sessions`,
    method: "POST",
    redirect: "manual",
    data: body,
  });
  expect(wire[0].headers.get("Idempotency-Key")).toBe(idempotencyKey);
  expect(wire[1]).toMatchObject({
    url: `${options.baseUrl}${factoryPath}/mcp`,
    method: "POST",
    redirect: "manual",
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wallie_create_session",
        arguments: { ...body, idempotencyKey },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "wallie-qualification", version: "1.0.0" },
        },
      },
    },
  });
  expect(wire[1].headers.get("Accept")).toBe("application/json, text/event-stream");
  expect(wire[1].headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
  expect(wire[1].headers.get("Mcp-Method")).toBe("tools/call");
  expect(wire[1].headers.get("Mcp-Name")).toBe("wallie_create_session");
  for (const request of wire)
    expect(request.headers.get("Authorization")).toBe(`Bearer ${options.token}`);
});

it("decodes a final SSE tool error and preserves a separate HTTP bearer challenge", async () => {
  const mcp = factoryMcpFixture({
    ...options,
    fetch: async () =>
      new Response(
        [
          'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
          'data: {"jsonrpc":"2.0","id":1,"result":{"resultType":"complete","isError":true,"structuredContent":{"code":"stale_intent","error":"Review changed."}}}',
        ].join("\r\n\r\n"),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  expect(await mcp.call("wallie_send_follow_up", {})).toEqual({
    ok: false,
    status: 200,
    error: { code: "stale_intent", message: "Review changed." },
    wwwAuthenticate: null,
  });

  const challenge = 'Bearer error="invalid_token"';
  const denied = factoryMcpFixture({
    ...options,
    fetch: async () =>
      Response.json(
        { code: "unauthorized" },
        { status: 401, headers: { "WWW-Authenticate": challenge } },
      ),
  });
  expect(await denied.call("wallie_get_session", {})).toEqual({
    ok: false,
    status: 401,
    error: { code: "unauthorized" },
    wwwAuthenticate: challenge,
  });
});

it("retains protocol error codes without accepting an unrelated response ID", async () => {
  const badHeaders = factoryMcpFixture({
    ...options,
    fetch: async () =>
      Response.json(
        { jsonrpc: "2.0", id: 1, error: { code: -32020, message: "Header mismatch" } },
        { status: 400 },
      ),
  });
  expect(await badHeaders.call("wallie_get_session", {})).toMatchObject({
    ok: false,
    status: 400,
    error: { code: -32020, message: "Header mismatch" },
  });
  const unrelated = factoryMcpFixture({
    ...options,
    fetch: async () =>
      Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: { resultType: "complete", structuredContent: { session: "other" } },
      }),
  });
  expect(await unrelated.call("wallie_get_session", {})).toMatchObject({
    ok: false,
    status: 200,
    error: { code: "invalid_response" },
  });
});
