import type { SandboxHandle } from "@/lib/sandbox/types";
import { isMcpBearerToken } from "@/lib/factory-mcp/manifest";

import { mcpStdioBridge } from "./mcp-stdio-bridge";
import type { AgentOutputSafety } from "./safety";
import type { ScopedRunnerMaterial } from "./scoped-credentials";
import type { AgentEvent, AgentRunnerStartInput } from "./types";

export class McpAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAdapterError";
  }
}

export async function prepareMcpAdapter({
  runtime,
  sandbox,
  directory,
  signal,
  material,
}: {
  runtime: NonNullable<AgentRunnerStartInput["mcp"]>;
  sandbox: SandboxHandle;
  directory: string;
  signal?: AbortSignal;
  material: ScopedRunnerMaterial;
}) {
  const programPath = `${directory}/wallie-mcp.cjs`;
  const sources = runtime.manifest.servers.map((server, index) => {
    const name = `wallie${index + 1}`;
    const path = `${directory}/${name}.mcp.json`;
    const portable = server.operations.every(
      (operation) =>
        /^[A-Za-z0-9-][A-Za-z0-9_-]{0,43}$/.test(operation) && !operation.includes("__"),
    );
    const operations = server.operations.map((operation, position) => ({
      name: portable
        ? operation
        : `op${position + 1}_${operation.replace(/[._]+/g, "-").slice(0, 36)}`,
      operation,
    }));
    return {
      server,
      path,
      config: { name, command: "node", args: [programPath, path], operations },
    };
  });
  signal?.throwIfAborted();
  for (const { path } of sources) material.trackFile(`${path}.ready`);
  await material.writeFile(programPath, mcpStdioBridge);
  const receipt = {
    type: "mcp_receipt",
    servers: sources.map(({ server }) => ({
      slug: server.serverSlug,
      revision: server.revisionNumber,
      operations: server.operations,
    })),
  } satisfies AgentEvent;

  return {
    servers: sources.map(({ config }) => config),
    receipt,
    async stageCredentials(material: ScopedRunnerMaterial, safety: AgentOutputSafety) {
      signal?.throwIfAborted();
      const credentials = await runtime.loadCredentials();
      for (const token of credentials.values()) safety.addSecret(token);
      signal?.throwIfAborted();
      const receiptText = JSON.stringify(receipt);
      if (safety.redact(receiptText) !== receiptText) {
        throw new McpAdapterError("The approved MCP tool metadata contains sensitive material.");
      }
      const bearerServers = sources.filter(({ server }) => server.auth.kind === "bearer");
      if (
        credentials.size !== bearerServers.length ||
        bearerServers.some(({ server }) => {
          const credential = credentials.get(server.toolRevisionId);
          return !credential || !isMcpBearerToken(credential);
        })
      ) {
        throw new McpAdapterError("The approved MCP bearer credentials could not be resolved.");
      }
      for (const { config, path, server } of sources) {
        const bearer = credentials.get(server.toolRevisionId);
        await material.writeFile(
          path,
          JSON.stringify({ endpoint: server.endpoint, operations: config.operations, bearer }),
        );
      }
    },
    async verifyReady(): Promise<typeof receipt> {
      signal?.throwIfAborted();
      const markers = await Promise.all(
        sources.map(({ path }) => sandbox.readFile(`${path}.ready`)),
      );
      if (markers.some((marker) => marker !== "ready\n")) {
        throw new McpAdapterError("An approved MCP server did not expose its complete tool scope.");
      }
      return receipt;
    },
  };
}
