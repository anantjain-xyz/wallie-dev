import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  mcpAuthKindSchema,
  mcpIdSchema,
  mcpManifestServerSchema,
} from "@/lib/factory-mcp/manifest";
import type { Database } from "@/lib/supabase/database.types";

import type { FactoryDefinitionCatalog } from "./references";

export type FactoryMcpCatalogSelection = {
  mcpToolRevisionIds?: readonly string[];
  mcpSecretBindingIds?: readonly string[];
  mcpExecutionGrantId?: string;
};

const revisionSchema = mcpManifestServerSchema.omit({ auth: true }).extend({
  authKind: mcpAuthKindSchema,
});

function selectedIds(references: readonly string[]) {
  return [
    ...new Set(
      references.flatMap((reference) => {
        const id = mcpIdSchema.safeParse(reference);
        return id.success ? [id.data] : [];
      }),
    ),
  ];
}

export async function loadFactoryMcpCatalog(
  client: SupabaseClient<Database>,
  {
    workspaceId,
    factoryId,
    mcpToolRevisionIds = [],
    mcpSecretBindingIds = [],
    mcpExecutionGrantId,
  }: FactoryMcpCatalogSelection & { workspaceId: string; factoryId: string },
): Promise<Pick<FactoryDefinitionCatalog, "tools" | "mcpSecretBindings" | "mcpExecutionGrant">> {
  const revisions = selectedIds(mcpToolRevisionIds);
  if (!revisions.length) return { tools: [] };

  const bindings = selectedIds(mcpSecretBindingIds);
  const grantId = mcpIdSchema.safeParse(mcpExecutionGrantId);
  const [revisionsResult, bindingsResult, grantResult] = await Promise.all([
    client
      .from("factory_mcp_server_revisions")
      .select(
        "id, server_id, revision_number, endpoint, operation_names, auth_kind, factory_mcp_servers!inner(slug)",
      )
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .is("revoked_at", null)
      .in("id", revisions),
    bindings.length
      ? client
          .from("factory_mcp_secret_bindings")
          .select(
            "id, execution_grant_id, service_principal_id, factory_agent_id, tool_revision_id",
          )
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .is("revoked_at", null)
          .in("id", bindings)
      : { data: [], error: null },
    grantId.success
      ? client
          .from("factory_execution_grants")
          .select("id, version, service_principal_id, tool_ids")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("id", grantId.data)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
          .maybeSingle()
      : { data: null, error: null },
  ]);
  if (revisionsResult.error) throw revisionsResult.error;
  if (bindingsResult.error) throw bindingsResult.error;
  if (grantResult.error) throw grantResult.error;
  const grant = grantResult.data;

  return {
    tools: revisionsResult.data.map((row) => {
      const { toolRevisionId, ...entry } = revisionSchema.parse({
        toolRevisionId: row.id,
        serverId: row.server_id,
        serverSlug: row.factory_mcp_servers.slug,
        revisionNumber: row.revision_number,
        endpoint: row.endpoint,
        operations: row.operation_names,
        authKind: row.auth_kind,
      });
      return { id: toolRevisionId, workspaceId, ...entry };
    }),
    mcpSecretBindings: (bindingsResult.data ?? []).map((binding) => ({
      id: binding.id,
      workspaceId,
      grantId: binding.execution_grant_id,
      servicePrincipalId: binding.service_principal_id,
      agentId: binding.factory_agent_id,
      toolRevisionId: binding.tool_revision_id,
    })),
    ...(grant
      ? {
          mcpExecutionGrant: {
            id: grant.id,
            workspaceId,
            servicePrincipalId: grant.service_principal_id,
            toolIds: grant.tool_ids,
            version: grant.version,
          },
        }
      : {}),
  };
}
