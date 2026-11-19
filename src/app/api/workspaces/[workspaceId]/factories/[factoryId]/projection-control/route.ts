import { z } from "zod/v4";

import {
  projectionActionSchema,
  projectionHealthSchema,
} from "@/features/factory-overview/projection-health-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";

const commandSchema = z.strictObject({ action: projectionActionSchema });

function failure(status: number, error: string) {
  return Response.json({ error }, { status, headers });
}

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ workspaceId: string; factoryId: string }>;
  },
) {
  if (new URL(request.url).search) return failure(400, "Unexpected projection control query.");
  const raw = await readBoundedJsonBody(request, 1024);
  if (!raw.ok) {
    if (raw.code === "request_too_large") return failure(413, "The request is too large.");
    if (raw.code === "unsupported_media_type")
      return failure(415, "Send the request as application/json.");
    return failure(400, "Invalid projection command.");
  }
  const command = commandSchema.safeParse(raw.body);
  if (!command.success) return failure(400, "Invalid projection command.");

  const scope = await resolveFactoryRouteContext(params);
  if (!scope.ok) return scope.response;
  const { data, error } = await scope.access.supabase
    .rpc("control_factory_flow_projection", {
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_action: command.data.action,
    })
    .abortSignal(request.signal);
  if (error?.code === "PT404") return failure(404, "Projection controls are unavailable.");
  if (error?.code === "22023") return failure(400, "Invalid projection command.");
  if (error) return failure(503, "Could not update the analytics projection.");
  const result = projectionHealthSchema.safeParse(data);
  return result.success
    ? Response.json(result.data, { headers })
    : failure(503, "Could not read the projection status.");
}
