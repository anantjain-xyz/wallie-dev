import { z } from "zod";

import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { isSameOriginFactoryOAuthPost } from "@/lib/factory-oauth/browser-auth";
import { factoryOAuthManagementSchema } from "@/lib/factory-oauth/management-contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  if (!isSameOriginFactoryOAuthPost(request)) {
    return Response.json({ error: "Send this request from Wallie." }, { status: 403, headers });
  }
  const scope = z.object({ workspaceId: z.string().uuid() }).safeParse(await params);
  if (!scope.success) {
    return Response.json({ error: "Provide a valid workspace ID." }, { status: 400, headers });
  }
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  const parsed = factoryOAuthManagementSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Provide a valid OAuth client command." },
      { status: 400, headers },
    );
  }
  const command = parsed.data;
  const access = await requireWorkspaceAccessById(scope.data.workspaceId, {
    requireManager: command.action !== "revoke-grant",
  });
  if (!access.ok) {
    return Response.json({ error: access.error }, { status: access.status, headers });
  }

  const admin = createSupabaseAdminClient();
  const actor = {
    p_workspace_id: access.context.workspace.id,
    p_actor_user_id: access.context.user.id,
  };

  if (command.action === "register") {
    const { data, error } = await admin.rpc("register_factory_oauth_client", {
      ...actor,
      p_name: command.name,
      p_redirect_uris: command.redirectUris,
      p_allowed_scopes: command.scopes,
      p_bindings: command.bindings.map((binding) => ({
        factory_id: binding.factoryId,
        execution_grant_id: binding.executionGrantId,
        execution_grant_version: binding.executionGrantVersion,
      })),
    });
    if (error || !data) {
      return Response.json(
        {
          error:
            "Could not register the client. Confirm its redirects and current execution grants.",
        },
        { status: factoryErrorStatus(error?.code), headers },
      );
    }
    return Response.json({ client: { id: data.id } }, { status: 201, headers });
  }

  const revoke =
    command.action === "revoke-client"
      ? admin.rpc("revoke_factory_oauth_client", { ...actor, p_client_id: command.clientId })
      : admin.rpc("revoke_factory_oauth_grant", { ...actor, p_grant_id: command.grantId });
  const { error } = await revoke;
  if (error) {
    return Response.json(
      { error: "Could not revoke this OAuth access." },
      { status: factoryErrorStatus(error.code), headers },
    );
  }
  return Response.json({ revoked: true }, { headers });
}
