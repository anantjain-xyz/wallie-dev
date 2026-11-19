import {
  FactoryClient,
  type FactoryClientOptions,
} from "../../packages/factory-client/src/index.js";

export { FactoryApiError, FactoryClient } from "../../packages/factory-client/src/index.js";
export type { FactoryBody, FactoryResponse } from "../../packages/factory-client/src/index.js";

const protocolVersion = "2026-07-28";
const toolMethod = "tools/call";

type Options = Pick<
  FactoryClientOptions,
  "baseUrl" | "workspaceId" | "factoryId" | "token" | "fetch"
>;
type McpError = { code: string | number; message?: string; retryAfterSeconds?: number };
export type FactoryMcpFixtureResult<T> =
  | { ok: true; status: number; result: T }
  | { ok: false; status: number; error: McpError; wwwAuthenticate: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function readEnvelope(response: Response, id: number): Promise<unknown> {
  const body = await response.text();
  if (!response.headers.get("Content-Type")?.includes("text/event-stream")) return parseJson(body);
  for (const frame of body.split(/\r?\n\r?\n/)) {
    const payload = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    const message = parseJson(payload);
    if (isRecord(message) && message.id === id) return message;
  }
  return null;
}

function parseError(value: unknown): McpError {
  if (!isRecord(value)) return { code: "invalid_response" };
  const code =
    typeof value.code === "string" || typeof value.code === "number"
      ? value.code
      : typeof value.error === "string" && /^[a-z_]+$/.test(value.error)
        ? value.error
        : "invalid_response";
  const message = [value.message, value.error_description, value.error].find(
    (field): field is string => typeof field === "string" && field !== code,
  );
  const retryAfterSeconds = value.retryAfterSeconds;
  return {
    code,
    ...(message && { message }),
    ...(typeof retryAfterSeconds === "number" && { retryAfterSeconds }),
  };
}

export function factoryMcpFixture(options: Options) {
  const client = new FactoryClient(options);
  const workspace = options.workspaceId.toLowerCase();
  const factory = options.factoryId.toLowerCase();
  const url = client.toUrl(`/api/v1/workspaces/${workspace}/factories/${factory}/mcp`);
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const authorization = `Bearer ${options.token}`;
  let nextId = 0;

  return {
    async call<T extends object>(
      name: string,
      args: Readonly<Record<string, unknown>>,
    ): Promise<FactoryMcpFixtureResult<T>> {
      const id = ++nextId;
      const response = await send(url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": protocolVersion,
          "Mcp-Method": toolMethod,
          "Mcp-Name": name,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: toolMethod,
          params: {
            name,
            arguments: args,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": protocolVersion,
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "wallie-qualification",
                version: "1.0.0",
              },
            },
          },
        }),
      });
      const fail = (error: unknown): FactoryMcpFixtureResult<T> => ({
        ok: false,
        status: response.status,
        error: parseError(error),
        wwwAuthenticate: response.headers.get("WWW-Authenticate"),
      });
      const body = await readEnvelope(response, id);
      if (!response.ok) {
        return fail(
          isRecord(body) && body.jsonrpc === "2.0" && isRecord(body.error) ? body.error : body,
        );
      }
      if (!isRecord(body) || body.jsonrpc !== "2.0" || body.id !== id) return fail(null);
      if (isRecord(body.error)) return fail(body.error);
      const result = body.result;
      if (!isRecord(result) || result.resultType !== "complete") return fail(null);
      if (result.isError === true) return fail(result.structuredContent);
      if (!isRecord(result.structuredContent)) return fail(null);
      return { ok: true, status: response.status, result: result.structuredContent as T };
    },
  };
}
