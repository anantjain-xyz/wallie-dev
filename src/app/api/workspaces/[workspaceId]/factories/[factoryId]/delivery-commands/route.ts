import {
  factoryDeliveryCandidateSchema,
  factoryDeliveryCommandIdSchema,
  factoryDeliveryCommandRequestSchema,
  factoryDeliveryCommandSchema,
} from "@/lib/factory-delivery-commands/contracts";
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

function commandErrorStatus(error: { code: string }) {
  return error.code === "55P03" ? 409 : factoryErrorStatus(error.code);
}

function commandResponse(data: unknown, error: { code: string } | null) {
  if (error) return failure(commandErrorStatus(error), "Could not apply the delivery command.");
  const parsed = factoryDeliveryCommandSchema.safeParse(data);
  if (!parsed.success) return failure(500, "Could not read the delivery command.");
  return Response.json({ command: parsed.data }, { headers });
}

export async function GET(request: Request, { params }: Context) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;

  const query = new URL(request.url).searchParams;
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
  };
  const admin = createSupabaseAdminClient();
  if (query.size === 2) {
    const sessionId = factoryDeliveryCommandIdSchema.safeParse(query.get("sessionId"));
    const sourceId = factoryDeliveryCommandIdSchema.safeParse(query.get("deploymentSourceId"));
    if (!sessionId.success || !sourceId.success)
      return failure(400, "Provide a session and deployment source.");
    const { data, error } = await admin.rpc("read_factory_delivery_command_candidate", {
      ...actor,
      p_session_id: sessionId.data,
      p_deployment_source_id: sourceId.data,
    });
    if (error)
      return failure(commandErrorStatus(error), "No approved delivery candidate is available.");
    const parsed = factoryDeliveryCandidateSchema.safeParse(data);
    if (!parsed.success) return failure(500, "Could not read the delivery candidate.");
    return Response.json({ candidate: parsed.data }, { headers });
  }
  const commandId = factoryDeliveryCommandIdSchema.safeParse(query.get("commandId"));
  if (query.size !== 1 || !commandId.success)
    return failure(400, "Provide one delivery command ID.");

  const { data, error } = await admin.rpc("read_factory_delivery_command", {
    ...actor,
    p_command_id: commandId.data,
  });
  return commandResponse(data, error);
}

export async function POST(request: Request, { params }: Context) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (new URL(request.url).search) return failure(400, "Unexpected delivery command query.");

  const raw = await readBoundedJsonBody(request, 24_576);
  if (!raw.ok) {
    if (raw.code === "request_too_large")
      return failure(413, "The JSON request exceeds the supported size.");
    if (raw.code === "unsupported_media_type")
      return failure(415, "Send the request as application/json.");
    return failure(400, "Invalid delivery command.");
  }
  const command = factoryDeliveryCommandRequestSchema.safeParse(raw.body);
  if (!command.success) return failure(400, "Invalid delivery command.");

  const admin = createSupabaseAdminClient();
  const input = command.data;
  const actor = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
    p_command_id: input.commandId,
  };
  if (input.action === "cancel") {
    const { data, error } = await admin.rpc("cancel_factory_delivery_command", actor);
    return commandResponse(data, error);
  }
  const evidence = {
    ...actor,
    p_session_id: input.sessionId,
    p_checkpoint_run_id: input.checkpointRunId,
    p_approval_id: input.approvalId,
    p_policy_revision_id: input.policyRevisionId,
    p_merge_observation_id: input.mergeObservationId,
    p_deployment_source_id: input.deploymentSourceId,
  };
  const { actions } = input;
  const { data, error } = actions
    ? await admin.rpc("prepare_factory_actions_delivery_command", {
        ...evidence,
        p_workflow_id: actions.workflowId,
        p_workflow_path: actions.workflowPath,
        p_tag: actions.tag,
        p_inputs: actions.inputs,
      })
    : await admin.rpc("prepare_factory_delivery_command", evidence);
  return commandResponse(data, error);
}
