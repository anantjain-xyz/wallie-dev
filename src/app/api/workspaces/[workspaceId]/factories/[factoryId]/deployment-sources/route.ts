import {
  factoryDeploymentMaxBodyBytes,
  factoryDeploymentSourceCommandSchema,
  factoryDeploymentSourceSchema,
} from "@/lib/factory-deployments/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

function failure(status: number, error: string) {
  return Response.json({ error }, { status, headers });
}

export async function POST(request: Request, { params }: Context) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (new URL(request.url).search) return failure(400, "Unexpected deployment source query.");

  const raw = await readBoundedJsonBody(request, factoryDeploymentMaxBodyBytes);
  if (!raw.ok) {
    if (raw.code === "request_too_large")
      return failure(413, "The JSON request exceeds the supported size.");
    if (raw.code === "unsupported_media_type")
      return failure(415, "Send the request as application/json.");
    return failure(400, "Invalid deployment source command.");
  }

  const command = factoryDeploymentSourceCommandSchema.safeParse(raw.body);
  if (!command.success) return failure(400, "Invalid deployment source command.");
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
  };
  const admin = createSupabaseAdminClient();
  const input = command.data;
  const { data, error } =
    input.action === "approve"
      ? await admin.rpc("approve_factory_deployment_source", {
          ...actor,
          p_execution_grant_id: input.executionGrantId,
          p_execution_grant_version: input.executionGrantVersion,
          p_provider: input.provider,
          p_provider_project_id: input.providerProjectId,
          p_environment: input.environment,
          p_provider_time_authoritative: input.providerTimeAuthoritative,
        })
      : await admin.rpc("revoke_factory_deployment_source", {
          ...actor,
          p_source_id: input.sourceId,
        });
  if (error) {
    return failure(
      error.code === "PT403" ? 403 : factoryErrorStatus(error.code),
      "Could not change the deployment source.",
    );
  }
  const source = factoryDeploymentSourceSchema.safeParse(data);
  if (!source.success) return failure(500, "Could not read the deployment source.");
  return Response.json(
    { source: source.data },
    { status: input.action === "approve" ? 201 : 200, headers },
  );
}
