import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import {
  monitoringBindingCommandSchema,
  monitoringBindingListSchema,
  monitoringBindingSchema,
} from "@/lib/factory-monitoring/contracts";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

function failure(status: number) {
  return Response.json(
    { error: "Could not complete the monitoring binding request." },
    { status, headers },
  );
}

export async function GET(request: Request, { params }: Context) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (new URL(request.url).search) return failure(400);
  const { data, error } = await createSupabaseAdminClient().rpc(
    "list_factory_monitoring_bindings",
    {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
    },
  );
  if (error) return failure(factoryErrorStatus(error.code));
  const bindings = monitoringBindingListSchema.safeParse(data);
  return bindings.success ? Response.json({ bindings: bindings.data }, { headers }) : failure(500);
}

export async function POST(request: Request, { params }: Context) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (new URL(request.url).search) return failure(400);
  const raw = await readBoundedJsonBody(request, 4096);
  if (!raw.ok) {
    const status = { request_too_large: 413, unsupported_media_type: 415, invalid_request: 400 };
    return failure(status[raw.code]);
  }
  const command = monitoringBindingCommandSchema.safeParse(raw.body);
  if (!command.success) return failure(400);

  const input = command.data;
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
    p_binding_id: input.bindingId,
  };
  try {
    const admin = createSupabaseAdminClient();
    const { data, error } =
      input.action === "approve"
        ? await admin.rpc("approve_factory_monitoring_binding", {
            ...actor,
            p_deployment_source_id: input.deploymentSourceId,
            p_installation_id: input.installationId,
            p_project_id: input.projectId,
            p_encrypted_secret: encryptSecretValue(input.signingSecret),
            p_suppression_seconds: input.suppressionSeconds,
          })
        : await admin.rpc("disable_factory_monitoring_binding", actor);
    if (error) return failure(error.code === "PT422" ? 422 : factoryErrorStatus(error.code));
    const binding = monitoringBindingSchema.safeParse(data);
    if (!binding.success) return failure(500);
    return Response.json(
      { binding: binding.data },
      { status: input.action === "approve" ? 201 : 200, headers },
    );
  } catch {
    return failure(503);
  }
}
