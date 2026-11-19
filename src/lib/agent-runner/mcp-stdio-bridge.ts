// This single-server stdio adapter runs in the sandbox, independent of the
// repository's packages. Its only upstream transport is pinned Streamable HTTP.
export const mcpStdioBridge = String.raw`
"use strict";

const { readFileSync, unlinkSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const descriptor = process.argv[2];
const maxResponseBytes = 8 * 1024 * 1024;
const timeoutMs = 30_000;

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const protocolError = (message) => new ProtocolError(-32000, message);

async function readResponse(response, id) {
  const reader = response.body?.getReader();
  if (!reader) throw protocolError("The approved MCP endpoint returned no response.");
  const decoder = new TextDecoder();
  const eventStream = response.headers.get("content-type")?.startsWith("text/event-stream");
  let bytes = 0;
  let buffer = "";
  let event = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw protocolError("The approved MCP response is too large.");
      buffer += decoder.decode(value, { stream: true });
      if (!eventStream) continue;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) event.push(line.slice(5).replace(/^ /, ""));
        if (line === "" && event.length) {
          const message = JSON.parse(event.join("\n"));
          event = [];
          if (message.id === id && ("result" in message || "error" in message)) return message;
        }
      }
    }
    if (!eventStream) return JSON.parse(buffer + decoder.decode());
    throw protocolError("The approved MCP event stream ended before its response.");
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function start() {
  let privateConfig;
  try {
    const serialized = readFileSync(descriptor, "utf8");
    unlinkSync(descriptor);
    privateConfig = JSON.parse(serialized);
  } catch {
    process.exitCode = 1;
    return;
  }
  const { endpoint, operations, bearer } = privateConfig;
  const byName = new Map(operations.map(({ name, operation }) => [name, operation]));
  const active = new Map();
  let sessionId;
  let version;
  let requestId = 0;
  let starting = false;
  let toolList;

  function headers() {
    return {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(bearer ? { authorization: "Bearer " + bearer } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(version ? { "mcp-protocol-version": version } : {}),
    };
  }

  async function post(method, params, signal, notification = false) {
    const id = notification ? undefined : ++requestId;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw protocolError("The approved MCP endpoint rejected the request.");
    }
    if (method === "initialize") sessionId = response.headers.get("mcp-session-id");
    if (notification) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    const envelope = await readResponse(response, id);
    if (envelope.jsonrpc !== "2.0" || envelope.id !== id || !("result" in envelope)) {
      throw protocolError("The approved MCP endpoint could not complete the operation.");
    }
    return envelope.result;
  }

  async function initialize(params, signal) {
    if (starting) throw protocolError("The MCP adapter is already initialized.");
    starting = true;
    const result = await post("initialize", {
      protocolVersion: params?.protocolVersion,
      capabilities: {},
      clientInfo: { name: "Wallie", version: "1" },
    }, signal);
    if (typeof result?.protocolVersion !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion)) {
      throw protocolError("The approved MCP endpoint did not negotiate a protocol version.");
    }
    version = result.protocolVersion;
    await post("notifications/initialized", undefined, signal, true);

    const needed = new Set(byName.values());
    const declared = new Map();
    const visited = new Set();
    let cursor;
    do {
      const list = await post("tools/list", cursor ? { cursor } : {}, signal);
      if (!Array.isArray(list?.tools)) throw protocolError("The approved MCP tool list is invalid.");
      for (const tool of list.tools) {
        if (!needed.has(tool?.name)) continue;
        if (declared.has(tool.name) || !tool.inputSchema || tool.inputSchema.type !== "object") {
          throw protocolError("An approved MCP operation has an invalid tool definition.");
        }
        const { description, inputSchema, outputSchema, title, annotations } = tool;
        declared.set(tool.name, { description, inputSchema, outputSchema, title, annotations });
      }
      cursor = list.nextCursor;
      if (declared.size === needed.size || !cursor) break;
      if (typeof cursor !== "string" || visited.has(cursor) || visited.size >= 31) {
        throw protocolError("The approved MCP tool list exceeds the adapter's pagination limit.");
      }
      visited.add(cursor);
    } while (true);
    if (declared.size !== needed.size) {
      throw protocolError("An approved MCP operation is unavailable at the pinned endpoint.");
    }
    const approvedTools = operations.map(({ name, operation }) => ({ ...declared.get(operation), name }));
    verifySafeResult(approvedTools);
    writeFileSync(descriptor + ".ready", "ready\n", { flag: "wx", mode: 0o600 });
    toolList = approvedTools;
    return { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "Wallie", version: "1" } };
  }

  function verifySafeResult(result) {
    if (bearer && JSON.stringify(result).includes(bearer)) {
      throw protocolError("The approved MCP endpoint returned sensitive material.");
    }
  }

  async function dispatch({ method, params }, signal) {
    if (method === "initialize") return initialize(params, signal);
    if (method === "ping") return {};
    if (!toolList) throw protocolError("The approved MCP server is unavailable.");
    if (method === "tools/list") return { tools: toolList };
    if (method === "tools/call") {
      const name = byName.get(params?.name);
      if (!name) throw new ProtocolError(-32602, "This MCP operation is outside the approved tool scope.");
      return post(method, { name, arguments: params.arguments }, signal);
    }
    throw new ProtocolError(-32601, "This MCP method is outside the approved tool scope.");
  }

  async function handle(line) {
    let id = null;
    let controller;
    try {
      const message = JSON.parse(line);
      if (message.id === undefined) {
        if (message.method === "notifications/cancelled") active.get(message.params?.requestId)?.abort();
        return;
      }
      id = message.id;
      controller = new AbortController();
      active.set(id, controller);
      const result = await dispatch(message, AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]));
      verifySafeResult(result);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
    } catch (error) {
      const code = error instanceof ProtocolError ? error.code : -32000;
      const message = error instanceof ProtocolError ? error.message : "The approved MCP operation failed.";
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
    } finally {
      if (controller && active.get(id) === controller) active.delete(id);
    }
  }

  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => void handle(line));
  input.once("close", async () => {
    for (const controller of active.values()) controller.abort();
    if (sessionId) {
      try {
        const response = await fetch(endpoint, { method: "DELETE", headers: headers(), redirect: "error", signal: AbortSignal.timeout(1_000) });
        void response.body?.cancel().catch(() => undefined);
      } catch {
        // Session deletion is optional for Streamable HTTP servers.
      }
    }
    process.exit();
  });
}

start();
`;
