import {
  connectorCatalogQuerySchema,
  connectorCatalogResponseSchema,
} from "@/lib/connectors/setup-contracts";
import {
  connectorSetupErrorResponse,
  readConnectorCatalog,
  resolveConnectorSetupContext,
} from "@/lib/connectors/setup";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

export const preferredRegion = "home";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const parsed = connectorCatalogQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return Response.json({ error: "Invalid connector catalog request." }, { status: 400, headers });
  }

  try {
    const context = await resolveConnectorSetupContext(params);
    if (!context.ok) return context.response;
    const catalog = await readConnectorCatalog(context.admin, context.scope, parsed.data);
    return Response.json(connectorCatalogResponseSchema.parse(catalog), { headers });
  } catch (error) {
    return connectorSetupErrorResponse(error);
  }
}
