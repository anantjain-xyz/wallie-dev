import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import {
  factorySecretBindingCommandSchema,
  factorySecretBindingMutationResponseSchema,
  factorySecretBindingQuerySchema,
  factorySecretBindingResponseSchema,
} from "@/lib/factory-secret-bindings/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };
type Binding = Database["public"]["Functions"]["list_factory_secret_bindings"]["Returns"][number];

function metadata(binding: Binding | undefined, grantMatches: boolean) {
  if (!binding) return null;
  return {
    id: binding.id,
    version: binding.version,
    status: grantMatches || binding.status === "revoked" ? binding.status : "grant_unavailable",
    materialRevision: binding.material_revision,
    rotatedAt: binding.rotated_at,
    secretKey: binding.secret_key ?? null,
    ...(binding.open_code_provider_id ? { openCodeProviderId: binding.open_code_provider_id } : {}),
  };
}

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const scope = factorySecretBindingQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!scope.success) {
    return Response.json({ error: "Provide a valid credential scope." }, { status: 400, headers });
  }

  const admin = createSupabaseAdminClient();
  const { agentId, bindingId, grantId, grantVersion, provider } = scope.data;
  const openCodeProviderId = provider === "opencode" ? scope.data.openCodeProviderId : undefined;
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
  };
  const [bindings, grant] = await Promise.all([
    admin.rpc("list_factory_secret_bindings", actor),
    context.access.supabase
      .from("factory_execution_grants")
      .select("version, revoked_at, expires_at")
      .eq("workspace_id", context.workspaceId)
      .eq("factory_id", context.factoryId)
      .eq("id", grantId)
      .maybeSingle(),
  ]);
  if (bindings.error || grant.error) {
    return Response.json(
      { error: "Could not load service credentials." },
      { status: factoryErrorStatus(bindings.error?.code ?? grant.error?.code), headers },
    );
  }

  const grantMatches = Boolean(
    grant.data &&
    grant.data.version === grantVersion &&
    grant.data.revoked_at === null &&
    new Date(grant.data.expires_at).getTime() > Date.now(),
  );
  const matching = bindings.data.filter(
    (binding) =>
      binding.workspace_id === context.workspaceId &&
      binding.factory_id === context.factoryId &&
      binding.execution_grant_id === grantId &&
      binding.factory_agent_id === agentId &&
      binding.agent_provider === provider &&
      (binding.open_code_provider_id ?? undefined) === openCodeProviderId,
  );
  const active = matching.find((binding) => binding.status !== "revoked");
  const bound = bindingId ? matching.find((binding) => binding.id === bindingId) : active;
  const role = context.access.currentMember.role;
  const canAttach = grantMatches && !active && (role === "owner" || role === "admin");
  const eligible = canAttach
    ? await admin.rpc("list_factory_bindable_workspace_secrets", actor)
    : { data: [], error: null };
  if (eligible.error) {
    return Response.json(
      { error: "Could not load saved secret references." },
      { status: factoryErrorStatus(eligible.error.code), headers },
    );
  }

  const payload = factorySecretBindingResponseSchema.safeParse({
    binding: metadata(bound, grantMatches),
    availableBinding: active?.id !== bound?.id ? metadata(active, grantMatches) : null,
    grantMatches,
    eligibleSecrets: eligible.data,
  });
  if (!payload.success) {
    return Response.json(
      { error: "Could not load service credentials." },
      { status: 500, headers },
    );
  }
  return Response.json(payload.data, { headers });
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  const command = factorySecretBindingCommandSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!command.success) {
    return Response.json({ error: "Provide a valid binding command." }, { status: 400, headers });
  }
  const { data: input } = command;
  const role = context.access.currentMember.role;
  if (input.action === "attach" && role !== "owner" && role !== "admin") {
    return Response.json(
      { error: "Workspace admins can attach saved workspace secrets." },
      { status: 403, headers },
    );
  }

  const admin = createSupabaseAdminClient();
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
  };
  const mutation =
    input.action === "attach"
      ? admin.rpc("create_factory_secret_binding", {
          ...actor,
          p_execution_grant_id: input.grantId,
          p_execution_grant_version: input.grantVersion,
          p_factory_agent_id: input.agentId,
          p_agent_provider: input.provider,
          ...(input.provider === "opencode"
            ? { p_open_code_provider_id: input.openCodeProviderId }
            : {}),
          p_workspace_secret_id: input.workspaceSecretId,
        })
      : admin.rpc("revoke_factory_secret_binding", {
          ...actor,
          p_binding_id: input.bindingId,
          p_expected_version: input.expectedVersion,
        });
  const { data, error } = await mutation.select("id,version").single();
  const payload = factorySecretBindingMutationResponseSchema.safeParse(data);
  if (error || !payload.success) {
    const changed = error?.code === "PT409" || error?.code === "23505";
    return Response.json(
      {
        error: changed
          ? "The credential binding or grant changed. Reload its status and try again."
          : "Could not change the credential binding.",
      },
      { status: changed ? 409 : factoryErrorStatus(error?.code), headers },
    );
  }
  return Response.json(payload.data, { status: input.action === "attach" ? 201 : 200, headers });
}
