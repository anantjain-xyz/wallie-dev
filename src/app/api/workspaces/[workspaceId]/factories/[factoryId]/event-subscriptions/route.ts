import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import {
  executeFactoryEventSubscriptionCommand,
  FactoryEventSubscriptionError,
  loadFactoryEventDeliveries,
} from "@/lib/factory-event-subscriptions/management";
import {
  factoryEventDeliveryQuery,
  factoryEventSubscriptionCommand,
} from "@/lib/factory-event-subscriptions/management-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";

export const runtime = "nodejs";
export const preferredRegion = "home";
type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };

function errorResponse(error: unknown) {
  return error instanceof FactoryEventSubscriptionError
    ? Response.json({ error: error.message }, { status: error.status, headers })
    : Response.json(
        { error: "Event subscriptions are temporarily unavailable." },
        { status: 500, headers },
      );
}

export async function GET(request: Request, { params }: Context) {
  const search = new URL(request.url).searchParams;
  const entries = Object.fromEntries(search);
  const query = factoryEventDeliveryQuery.safeParse(entries);
  if (!query.success || Object.keys(entries).length !== search.size) {
    return Response.json(
      { error: "Provide a valid delivery history query." },
      { status: 400, headers },
    );
  }
  try {
    const scope = await resolveFactoryRouteContext(params);
    if (!scope.ok) return scope.response;
    return Response.json(
      await loadFactoryEventDeliveries(
        { ...scope, actorUserId: scope.access.user.id },
        query.data.subscriptionId,
        query.data.cursor,
      ),
      { headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  const command = factoryEventSubscriptionCommand.safeParse(await request.json().catch(() => null));
  if (!command.success) {
    return Response.json(
      { error: "Provide a valid event subscription command." },
      { status: 400, headers },
    );
  }
  try {
    const scope = await resolveFactoryRouteContext(params);
    if (!scope.ok) return scope.response;
    return Response.json(
      await executeFactoryEventSubscriptionCommand(
        { ...scope, actorUserId: scope.access.user.id },
        command.data,
      ),
      { status: command.data.action === "create" ? 201 : 200, headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
