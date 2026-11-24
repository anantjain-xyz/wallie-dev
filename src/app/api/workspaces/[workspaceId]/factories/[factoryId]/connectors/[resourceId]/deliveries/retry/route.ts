import { connectorRetryCommandSchema } from "@/lib/connectors/diagnostics-contracts";
import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { resolveConnectorDeliveriesScope, type ConnectorDeliveriesContext } from "../scope";

export async function POST(request: Request, { params }: ConnectorDeliveriesContext) {
  const context = await resolveConnectorDeliveriesScope(params);
  if (!context.ok) return context.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }

  const command = connectorRetryCommandSchema.safeParse(await request.json().catch(() => null));
  if (!command.success) {
    return Response.json({ error: "Select an exact retry delivery." }, { status: 400, headers });
  }

  const { data, error } = await createSupabaseAdminClient().rpc(
    "retry_factory_connector_delivery",
    {
      ...context.scope,
      p_kind: command.data.kind,
      p_delivery_id: command.data.id,
    },
  );
  if (error) {
    return Response.json(
      { error: "Could not schedule this connector delivery." },
      { status: factoryErrorStatus(error.code), headers },
    );
  }
  if (data !== true) {
    return Response.json(
      { error: "This delivery is no longer eligible to retry." },
      { status: 409, headers },
    );
  }
  return Response.json({ scheduled: true }, { headers });
}
