import { z } from "zod/v4";

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
const revision = z.number().int().nonnegative().safe();
const statusMapping = z
  .strictObject({
    teamId: uuid,
    fromStateId: uuid,
    toStateId: uuid,
  })
  .refine((mapping) => mapping.fromStateId !== mapping.toStateId);
const configuration = z.strictObject({
  revision,
  mappingRevision: revision.positive(),
  commentsEnabled: z.boolean(),
  statusMapping: statusMapping.nullable(),
});
const command = configuration.omit({ revision: true }).extend({ expectedRevision: revision });

async function resolveScope(params: RouteContext["params"]) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context;

  const resource = uuid.safeParse((await params).resourceId);
  if (!resource.success) {
    return {
      ok: false as const,
      response: Response.json({ error: "Invalid Linear resource." }, { status: 400, headers }),
    };
  }

  return {
    ok: true as const,
    role: context.access.currentMember.role,
    scope: {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
      p_resource_id: resource.data,
    },
  };
}

export async function GET(_request: Request, { params }: RouteContext) {
  const context = await resolveScope(params);
  if (!context.ok) return context.response;

  const { data, error } = await createSupabaseAdminClient().rpc(
    "read_linear_connector_outbound_config",
    context.scope,
  );
  if (error || data === null) {
    return Response.json(
      { error: "Linear outbound configuration is unavailable." },
      { status: error ? factoryErrorStatus(error.code) : 404, headers },
    );
  }
  const parsed = configuration.safeParse(data);
  if (!parsed.success) {
    return Response.json(
      { error: "Linear outbound configuration is unavailable." },
      { status: 500, headers },
    );
  }
  return Response.json(parsed.data, { headers });
}

export async function PUT(request: Request, { params }: RouteContext) {
  const context = await resolveScope(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  if (context.role !== "owner" && context.role !== "admin") {
    return Response.json(
      { error: "Workspace admin access is required." },
      { status: 403, headers },
    );
  }

  const parsed = command.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Provide valid Linear outbound permissions and status mapping." },
      { status: 400, headers },
    );
  }

  const input = parsed.data;
  const { data, error } = await createSupabaseAdminClient().rpc(
    "configure_linear_connector_outbound",
    {
      ...context.scope,
      p_expected_revision: input.expectedRevision,
      p_expected_mapping_revision: input.mappingRevision,
      p_comments_enabled: input.commentsEnabled,
      ...(input.statusMapping
        ? {
            p_status_team_id: input.statusMapping.teamId,
            p_status_from_state_id: input.statusMapping.fromStateId,
            p_status_to_state_id: input.statusMapping.toStateId,
          }
        : {}),
    },
  );
  if (error || data === null) {
    return Response.json(
      {
        error:
          error?.code === "PT409"
            ? "Linear connector setup changed. Reload the configuration before saving."
            : "Could not save Linear outbound configuration.",
      },
      { status: error ? factoryErrorStatus(error.code) : 500, headers },
    );
  }
  return Response.json({ revision: data }, { headers });
}
