import {
  MAX_MCP_OPERATIONS,
  mcpManifestScopeIds,
  mcpOperationScopeId,
  type FactoryMcpManifest,
} from "@/lib/factory-mcp/manifest";

import type { FactoryDefinitionDiagnostic } from "./compiler";
import {
  normalizeFactoryId,
  resolveFactoryReference,
  type FactoryDefinitionCatalog,
} from "./references";
import type { SerialFactoryDefinition } from "./schema";

export function compileFactoryMcpManifest({
  definition,
  catalog,
  agentId,
  diagnostics,
}: {
  definition: SerialFactoryDefinition;
  catalog: FactoryDefinitionCatalog;
  agentId: string | undefined;
  diagnostics: FactoryDefinitionDiagnostic[];
}): FactoryMcpManifest | undefined {
  if (definition.tools.length) {
    diagnostics.push({
      path: ["tools"],
      code: "unsupported_capability",
      message: "Choose approved MCP revisions and operations under mcpBindings.",
    });
  }
  const { mcpBindings } = definition;
  if (!mcpBindings?.length) return undefined;

  if (!agentId) {
    diagnostics.push({
      path: ["implementationAgent"],
      code: "missing_reference",
      message: "Choose a versioned implementation agent for MCP bindings.",
    });
    return undefined;
  }

  const grant = catalog.mcpExecutionGrant;
  if (
    !definition.executionGrant ||
    grant?.workspaceId !== catalog.workspaceId ||
    grant.id !== definition.executionGrant.id ||
    grant.version !== definition.executionGrant.version
  ) {
    diagnostics.push({
      path: ["executionGrant"],
      code: "missing_reference",
      message: "Choose a current execution grant for MCP bindings.",
    });
    return undefined;
  }

  const grantedOperations = new Set(grant.toolIds);
  const selectedServers = new Set<string>();
  const servers: FactoryMcpManifest["servers"] = [];
  for (const [index, binding] of mcpBindings.entries()) {
    const result = resolveFactoryReference(
      catalog.tools,
      catalog.workspaceId,
      binding.toolRevisionId,
    );
    if (!result.ok) {
      diagnostics.push({
        path: ["mcpBindings", index, "toolRevisionId"],
        code: result.code,
        message: "Choose an approved MCP revision in this factory.",
      });
      continue;
    }
    const revision = result.entry;
    if (selectedServers.has(revision.serverId)) {
      diagnostics.push({
        path: ["mcpBindings", index, "toolRevisionId"],
        code: "unsupported_capability",
        message: "Choose only one revision per MCP server.",
      });
      continue;
    }
    selectedServers.add(revision.serverId);

    const toolRevisionId = normalizeFactoryId(revision.id);
    if (
      binding.operations.some(
        (operation) =>
          !revision.operations.includes(operation) ||
          !grantedOperations.has(mcpOperationScopeId(toolRevisionId, operation)),
      )
    ) {
      diagnostics.push({
        path: ["mcpBindings", index, "operations"],
        code: "unsupported_capability",
        message: "Choose operations approved by both the MCP revision and this execution grant.",
      });
      continue;
    }

    const safeBinding = catalog.mcpSecretBindings?.find(
      ({ id, workspaceId }) =>
        id === binding.secretBindingId && workspaceId === catalog.workspaceId,
    );
    let auth: FactoryMcpManifest["servers"][number]["auth"];
    if (revision.authKind === "none" && !binding.secretBindingId) {
      auth = { kind: "none" };
    } else if (
      revision.authKind === "bearer" &&
      safeBinding?.grantId === grant.id &&
      safeBinding.agentId === agentId &&
      safeBinding.toolRevisionId === toolRevisionId &&
      safeBinding.servicePrincipalId === grant.servicePrincipalId
    ) {
      auth = { kind: "bearer", secretBindingId: safeBinding.id };
    } else {
      diagnostics.push({
        path: ["mcpBindings", index, "secretBindingId"],
        code: "unsupported_capability",
        message:
          "Match MCP authentication to an approved tool secret binding for this agent, grant, and revision.",
      });
      continue;
    }

    servers.push({
      toolRevisionId,
      serverId: revision.serverId,
      serverSlug: revision.serverSlug,
      revisionNumber: revision.revisionNumber,
      endpoint: revision.endpoint,
      operations: [...binding.operations].sort(),
      auth,
    });
  }

  if (mcpManifestScopeIds(servers).length > MAX_MCP_OPERATIONS) {
    diagnostics.push({
      path: ["mcpBindings"],
      code: "unsupported_capability",
      message: `Choose at most ${MAX_MCP_OPERATIONS} MCP operations per agent.`,
    });
  }
  return {
    agentId,
    servers: servers.sort((first, second) => {
      if (first.serverSlug === second.serverSlug) return 0;
      return first.serverSlug < second.serverSlug ? -1 : 1;
    }),
  };
}
