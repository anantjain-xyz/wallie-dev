import { z } from "zod/v4";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";

export type ConnectorDeliveriesContext = {
  params: Promise<{ workspaceId: string; factoryId: string; resourceId: string }>;
};

export async function resolveConnectorDeliveriesScope(
  params: ConnectorDeliveriesContext["params"],
) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context;

  const resource = z
    .uuid()
    .toLowerCase()
    .safeParse((await params).resourceId);
  if (!resource.success) {
    return {
      ok: false as const,
      response: Response.json({ error: "Invalid connector resource." }, { status: 400, headers }),
    };
  }

  return {
    ok: true as const,
    scope: {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
      p_resource_id: resource.data,
    },
  };
}
