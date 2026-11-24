import { z } from "zod/v4";

import {
  configureLinearDiscoverySchema,
  linearDiscoveryConfigSchema,
} from "@/lib/connectors/linear-policy-contracts";
import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; resourceId: string }>;
};
const uuid = z.uuid().toLowerCase();

export async function GET(_request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const resourceId = uuid.safeParse((await params).resourceId);
  if (!resourceId.success) {
    return Response.json({ error: "Invalid Linear resource." }, { status: 400, headers });
  }

  const { data, error } = await context.access.supabase.rpc("read_linear_issue_discovery_config", {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_resource_id: resourceId.data,
  });
  if (error || data === null) {
    return Response.json(
      { error: "Linear discovery is unavailable." },
      { status: error ? factoryErrorStatus(error.code) : 404, headers },
    );
  }
  const parsed = linearDiscoveryConfigSchema.safeParse(data);
  if (!parsed.success) {
    return Response.json({ error: "Linear discovery is unavailable." }, { status: 500, headers });
  }
  return Response.json(parsed.data, { headers });
}

export async function PUT(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  const role = context.access.currentMember.role;
  if (role !== "owner" && role !== "admin") {
    return Response.json(
      { error: "Workspace admin access is required." },
      { status: 403, headers },
    );
  }
  const resourceId = uuid.safeParse((await params).resourceId);
  const parsed = configureLinearDiscoverySchema.safeParse(await request.json().catch(() => null));
  if (!resourceId.success || !parsed.success) {
    return Response.json(
      { error: "Invalid Linear discovery configuration." },
      { status: 400, headers },
    );
  }

  const { data: input } = parsed;
  const { data, error } = await createSupabaseAdminClient().rpc(
    "configure_linear_issue_discovery",
    {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
      p_resource_id: resourceId.data,
      p_expected_revision: input.expectedRevision,
      p_expected_mapping_revision: input.mappingRevision,
      p_state_ids: input.stateIds,
      p_enabled: input.enabled,
      ...(input.labelId ? { p_label_id: input.labelId } : {}),
      ...(input.serviceActorId ? { p_service_actor_id: input.serviceActorId } : {}),
    },
  );
  if (error || data === null) {
    return Response.json(
      {
        error:
          error?.code === "PT422"
            ? "Publish a service-backed factory definition before enabling Linear discovery."
            : "Could not save Linear discovery configuration.",
      },
      { status: error ? factoryErrorStatus(error.code) : 500, headers },
    );
  }
  return Response.json({ revision: data }, { headers });
}
