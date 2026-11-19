import {
  factoryExecutionAuthorityPageSchema,
  factoryExecutionGrantCommandSchema,
  isFactoryExecutionAuthorityJsonRequest,
} from "@/lib/factory-execution-grants/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

const grantColumns =
  "id, workspace_id, factory_id, service_principal_id, github_repository_id, read_context_repository_ids, tool_ids, command_scopes, execution_policy_revision_id, budget_payer_member_id, expires_at, version, approved_by_member_id, approved_at, revoked_at, revoked_by_member_id, revocation_reason";

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const query = factoryExecutionAuthorityPageSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return Response.json(
      { error: "Invalid execution grant list request." },
      { status: 400, headers },
    );
  }

  const { afterId, limit } = query.data;
  let page = context.access.supabase
    .from("factory_execution_grants")
    .select(grantColumns)
    .eq("workspace_id", context.workspaceId)
    .eq("factory_id", context.factoryId)
    .order("id")
    .limit(limit + 1);
  if (afterId) page = page.gt("id", afterId);
  const { data, error } = await page;
  if (error) {
    return Response.json({ error: "Could not load execution grants." }, { status: 500, headers });
  }
  const grants = data.slice(0, limit);
  return Response.json(
    { grants, nextAfterId: data.length > limit ? grants.at(-1)?.id : null },
    { headers },
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  const command = factoryExecutionGrantCommandSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!command.success) {
    return Response.json(
      { error: "Provide a valid execution grant command." },
      { status: 400, headers },
    );
  }

  const admin = createSupabaseAdminClient();
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
  };
  const input = command.data;
  const mutation =
    input.action === "revoke"
      ? admin.rpc("revoke_factory_execution_grant", {
          ...actor,
          p_grant_id: input.grantId,
          p_expected_version: input.expectedVersion,
          p_reason: input.reason,
        })
      : admin.rpc("approve_factory_execution_grant", {
          ...actor,
          p_service_principal_id: input.servicePrincipalId,
          p_github_repository_id: input.writableRepositoryId,
          p_read_context_repository_ids: input.readContextRepositoryIds,
          p_tool_ids: input.toolIds,
          ...(input.commandScopes.length ? { p_command_scopes: input.commandScopes } : {}),
          p_execution_policy_revision_id: input.executionPolicyRevisionId,
          p_budget_payer_member_id: input.budgetPayerMemberId,
          p_expires_at: input.expiresAt,
          p_expected_version: input.action === "approve" ? 0 : input.expectedVersion,
          ...(input.action === "update" ? { p_grant_id: input.grantId } : {}),
        });
  const { data: grant, error } = await mutation.select(grantColumns).single();
  if (error || !grant) {
    return Response.json(
      {
        error:
          error?.code === "PT409"
            ? "This execution grant changed or was revoked. Reload before trying again."
            : "Could not change the execution grant.",
      },
      { status: factoryErrorStatus(error?.code), headers },
    );
  }
  return Response.json({ grant }, { status: input.action === "approve" ? 201 : 200, headers });
}
