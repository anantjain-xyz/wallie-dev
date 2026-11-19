import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

import { mcpStdioBridge } from "./mcp-stdio-bridge";

const token = "synthetic-mcp-fixture-token";
const mockTransport = String.raw`
const { appendFileSync } = require("node:fs");
globalThis.fetch = async (url, request) => {
  if (url !== "https://approved.example.test/mcp" || request.redirect !== "error") throw new Error("Wrong endpoint");
  if (request.headers.authorization !== "Bearer synthetic-mcp-fixture-token") throw new Error("Missing scoped token");
  const body = request.body ? JSON.parse(request.body) : null;
  appendFileSync(process.env.OP558_FIXTURE_LOG, JSON.stringify([request.method, body]) + "\n");
  if (request.method === "DELETE" || body.method === "notifications/initialized") return new Response(null, { status: 202 });
  const envelope = (result) => ({ jsonrpc: "2.0", id: body.id, result });
  if (body.method === "initialize") {
    if (Object.keys(body.params.capabilities).length !== 0) throw new Error("Unexpected upstream capabilities");
    return Response.json(envelope({ protocolVersion: "2025-03-26", capabilities: { resources: {}, tools: {} } }), { headers: { "mcp-session-id": "synthetic-session" } });
  }
  if (request.headers["mcp-session-id"] !== "synthetic-session" || request.headers["mcp-protocol-version"] !== "2025-03-26") throw new Error("Missing protocol state");
  const inputSchema = { type: "object" };
  if (body.method === "tools/list" && !body.params.cursor) return Response.json(envelope({ tools: [{ name: "delete_item", inputSchema }], nextCursor: "two" }));
  if (body.method === "tools/list") {
    const mode = process.env.OP558_FIXTURE_MODE;
    const listed = mode === "missing" ? [] : [{ name: "read.item", inputSchema, ...(mode === "tainted" ? { description: "synthetic-mcp-fixture-token" } : {}) }];
    return new Response("data: " + JSON.stringify(envelope({ tools: listed })) + "\r\n\r\n", { headers: { "content-type": "text/event-stream" } });
  }
  if (body.method === "tools/call") {
    const text = body.params.arguments?.echo ? "synthetic-mcp-fixture-token" : "allowed result";
    return Response.json(envelope({ content: [{ type: "text", text }] }));
  }
  throw new Error("Unexpected upstream request");
};
`;

it.each(["ready", "missing", "tainted"])(
  "filters the actual stdio catalog and calls with %s endpoint data",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "wallie-mcp-bridge-"));
    const bootstrap = join(directory, "bootstrap.json");
    const program = join(directory, "wallie-mcp.cjs");
    const transport = join(directory, "fixture.cjs");
    const log = join(directory, "requests.ndjson");
    await Promise.all([
      writeFile(program, mcpStdioBridge),
      writeFile(transport, mockTransport),
      writeFile(
        bootstrap,
        JSON.stringify({
          endpoint: "https://approved.example.test/mcp",
          operations: [{ name: "read_item", operation: "read.item" }],
          bearer: token,
        }),
        { mode: 0o600 },
      ),
    ]);
    const child = spawn(process.execPath, ["--require", transport, program, bootstrap], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { NODE_ENV: "test", OP558_FIXTURE_LOG: log, OP558_FIXTURE_MODE: mode },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "close");
    const output = createInterface({ input: child.stdout });
    let id = 0;
    async function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      const line = once(output, "line");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`);
      const [response] = await line;
      expect(response).not.toContain(token);
      return JSON.parse(String(response));
    }

    try {
      const init = await request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: { sampling: {} },
      });
      await expect(readFile(bootstrap)).rejects.toMatchObject({ code: "ENOENT" });
      if (mode !== "ready") {
        expect(init).toMatchObject({
          error: {
            message: expect.stringContaining(
              mode === "missing" ? "operation is unavailable" : "sensitive material",
            ),
          },
        });
        await expect(readFile(`${bootstrap}.ready`)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await request("tools/call", { name: "read_item", arguments: {} })).toMatchObject({
          error: { message: "The approved MCP server is unavailable." },
        });
      } else {
        expect(init).toMatchObject({ result: { capabilities: { tools: {} } } });
        await expect(readFile(`${bootstrap}.ready`, "utf8")).resolves.toBe("ready\n");
        expect(await request("tools/list")).toMatchObject({
          result: { tools: [{ name: "read_item", inputSchema: { type: "object" } }] },
        });
        expect(await request("tools/call", { name: "read_item", arguments: {} })).toMatchObject({
          result: { content: [{ type: "text", text: "allowed result" }] },
        });
        expect(
          await request("tools/call", { name: "read_item", arguments: { echo: true } }),
        ).toMatchObject({
          error: { message: expect.stringContaining("sensitive material") },
        });
        expect(await request("tools/call", { name: "delete_item" })).toMatchObject({
          error: { code: -32602 },
        });
        expect(await request("resources/read", { uri: "file:///private" })).toMatchObject({
          error: { code: -32601 },
        });
      }
      child.stdin.end();
      expect(await exited).toEqual([0, null]);
      const requests = await readFile(log, "utf8");
      expect(requests).toContain('["DELETE",null]');
      if (mode !== "ready") expect(requests).not.toContain("tools/call");
      expect(requests).not.toMatch(/delete_item|resources\/read|synthetic-mcp-fixture-token/);
      expect(stderr).toBe("");
    } finally {
      child.kill();
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
