import {
  connectorSetupCommandSchema,
  connectorSetupResponseSchema,
} from "@/lib/connectors/setup-contracts";
import {
  applyConnectorSetup,
  connectorSetupErrorResponse,
  resolveConnectorSetupContext,
} from "@/lib/connectors/setup";
import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";

export const preferredRegion = "home";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const context = await resolveConnectorSetupContext(params);
    if (!context.ok) return context.response;
    if (!isFactoryExecutionAuthorityJsonRequest(request)) {
      return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
    }
    const parsed = connectorSetupCommandSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid connector setup command." }, { status: 400, headers });
    }
    const result = await applyConnectorSetup(context.admin, context.scope, parsed.data);
    return Response.json(connectorSetupResponseSchema.parse(result), { headers });
  } catch (error) {
    return connectorSetupErrorResponse(error);
  }
}
