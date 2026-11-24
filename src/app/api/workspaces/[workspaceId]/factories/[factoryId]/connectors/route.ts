import { connectorInventorySchema } from "@/lib/connectors/diagnostics-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;

  const { data, error } = await createSupabaseAdminClient().rpc(
    "list_factory_connector_resources",
    {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
    },
  );
  if (error) {
    return Response.json(
      { error: "Connector resources are unavailable." },
      { status: factoryErrorStatus(error.code), headers },
    );
  }

  const result = connectorInventorySchema.safeParse(data);
  if (!result.success) {
    return Response.json(
      { error: "Connector resources are unavailable." },
      { status: 500, headers },
    );
  }
  return Response.json(result.data, { headers });
}
