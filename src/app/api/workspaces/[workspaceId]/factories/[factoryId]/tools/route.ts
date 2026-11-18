import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import {
  factoryMcpRegistryCommandSchema,
  factoryMcpRegistryQuerySchema,
} from "@/lib/factory-mcp/registry-contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

const revisionColumns =
  "id, server_id, revision_number, endpoint, operation_names, auth_kind, revoked_at, created_at";
const bindingColumns =
  "id, execution_grant_id, factory_agent_id, service_principal_id, tool_revision_id, revoked_at, created_at";

function revisionMetadata({
  id,
  server_id,
  revision_number,
  endpoint,
  operation_names,
  auth_kind,
  revoked_at,
  created_at,
}: Pick<
  Tables<"factory_mcp_server_revisions">,
  | "id"
  | "server_id"
  | "revision_number"
  | "endpoint"
  | "operation_names"
  | "auth_kind"
  | "revoked_at"
  | "created_at"
>) {
  return {
    id,
    serverId: server_id,
    revisionNumber: revision_number,
    endpoint,
    operationNames: operation_names,
    authKind: auth_kind,
    revokedAt: revoked_at,
    createdAt: created_at,
  };
}

function bindingMetadata({
  id,
  execution_grant_id,
  factory_agent_id,
  service_principal_id,
  tool_revision_id,
  revoked_at,
  created_at,
}: Pick<
  Tables<"factory_mcp_secret_bindings">,
  | "id"
  | "execution_grant_id"
  | "factory_agent_id"
  | "service_principal_id"
  | "tool_revision_id"
  | "revoked_at"
  | "created_at"
>) {
  return {
    id,
    grantId: execution_grant_id,
    agentId: factory_agent_id,
    servicePrincipalId: service_principal_id,
    toolRevisionId: tool_revision_id,
    revokedAt: revoked_at,
    createdAt: created_at,
  };
}

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const query = factoryMcpRegistryQuerySchema.safeParse({
    resource: "revisions",
    ...Object.fromEntries(new URL(request.url).searchParams),
  });
  if (!query.success) {
    return Response.json(
      { error: "Provide a valid MCP registry query." },
      { status: 400, headers },
    );
  }

  const { workspaceId, factoryId, access } = context;
  const input = query.data;
  if (input.resource === "secrets") {
    const { data, error } = await createSupabaseAdminClient().rpc(
      "list_factory_bindable_workspace_secrets",
      {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
        p_actor_user_id: access.user.id,
      },
    );
    if (error) return registryError("Could not load saved secret references.", error.code);
    return Response.json({ secrets: data.map(({ id, key }) => ({ id, key })) }, { headers });
  }

  const { limit, afterId } = input;
  if (input.resource === "bindings") {
    let page = access.supabase
      .from("factory_mcp_secret_bindings")
      .select(bindingColumns)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .eq("tool_revision_id", input.toolRevisionId)
      .order("id")
      .limit(limit + 1);
    if (afterId) page = page.gt("id", afterId);
    const { data, error } = await page;
    if (error) return registryError("Could not load MCP secret bindings.", error.code);
    const bindings = data.slice(0, limit).map(bindingMetadata);
    return Response.json(
      { bindings, nextAfterId: data.length > limit ? bindings.at(-1)?.id : null },
      { headers },
    );
  }

  let page = access.supabase
    .from("factory_mcp_server_revisions")
    .select(`${revisionColumns}, server:factory_mcp_servers!inner(name, slug)`)
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("id")
    .limit(limit + 1);
  if (input.serverId) page = page.eq("server_id", input.serverId);
  if (afterId) page = page.gt("id", afterId);
  const { data, error } = await page;
  if (error) return registryError("Could not load MCP revisions.", error.code);
  const revisions = data.slice(0, limit).map((row) => ({
    ...revisionMetadata(row),
    server: { name: row.server.name, slug: row.server.slug },
  }));
  return Response.json(
    { revisions, nextAfterId: data.length > limit ? revisions.at(-1)?.id : null },
    { headers },
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  const command = factoryMcpRegistryCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) {
    return Response.json(
      { error: "Provide a valid MCP registry command." },
      { status: 400, headers },
    );
  }
  const input = command.data;
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
  };
  const admin = createSupabaseAdminClient();

  if (input.action === "bind-secret" || input.action === "revoke-secret") {
    const mutation =
      input.action === "bind-secret"
        ? admin.rpc("create_factory_mcp_secret_binding", {
            ...actor,
            p_execution_grant_id: input.grantId,
            p_execution_grant_version: input.grantVersion,
            p_factory_agent_id: input.agentId,
            p_tool_revision_id: input.toolRevisionId,
            p_workspace_secret_id: input.workspaceSecretId,
          })
        : admin.rpc("revoke_factory_mcp_secret_binding", {
            ...actor,
            p_binding_id: input.bindingId,
          });
    const { data, error } = await mutation.select(bindingColumns).single();
    if (error || !data)
      return registryError("Could not change the MCP secret binding.", error?.code);
    return Response.json(
      { binding: bindingMetadata(data) },
      { status: input.action === "bind-secret" ? 201 : 200, headers },
    );
  }

  const mutation =
    input.action === "revoke"
      ? admin.rpc("revoke_factory_mcp_server_revision", {
          ...actor,
          p_server_id: input.serverId,
          p_revision_id: input.revisionId,
        })
      : input.action === "register"
        ? admin.rpc("create_factory_mcp_server", {
            ...actor,
            p_name: input.name,
            p_slug: input.slug,
            p_endpoint: input.endpoint,
            p_operation_names: input.operationNames,
            p_auth_kind: input.authKind,
          })
        : admin.rpc("save_factory_mcp_server_revision", {
            ...actor,
            p_server_id: input.serverId,
            p_expected_revision_number: input.expectedRevisionNumber,
            p_endpoint: input.endpoint,
            p_operation_names: input.operationNames,
            p_auth_kind: input.authKind,
          });
  const { data, error } = await mutation.select(revisionColumns).single();
  if (error || !data) return registryError("Could not change the MCP revision.", error?.code);
  return Response.json(
    { revision: revisionMetadata(data) },
    { status: input.action === "revoke" ? 200 : 201, headers },
  );
}

function registryError(message: string, code?: string) {
  return Response.json(
    { error: code === "PT409" ? "The registry changed. Reload before trying again." : message },
    { status: factoryErrorStatus(code), headers },
  );
}
