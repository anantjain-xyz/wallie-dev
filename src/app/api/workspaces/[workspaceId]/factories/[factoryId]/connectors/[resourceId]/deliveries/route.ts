import { Buffer } from "node:buffer";

import { z } from "zod/v4";

import {
  connectorDeliveryCursorSchema,
  connectorDeliveryLaneSchema,
  connectorDeliveryProjectionSchema,
} from "@/lib/connectors/diagnostics-contracts";
import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { resolveConnectorDeliveriesScope, type ConnectorDeliveriesContext } from "./scope";

const query = z.strictObject({
  lane: connectorDeliveryLaneSchema,
  limit: z
    .string()
    .regex(/^[0-9]{1,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(50)),
  cursor: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

function readCursor(cursor: string) {
  try {
    return connectorDeliveryCursorSchema.safeParse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    ).data;
  } catch {
    return undefined;
  }
}

export async function GET(request: Request, { params }: ConnectorDeliveriesContext) {
  const context = await resolveConnectorDeliveriesScope(params);
  if (!context.ok) return context.response;

  const search = new URL(request.url).searchParams;
  const parsed = query.safeParse({
    lane: search.get("lane") ?? "all",
    limit: search.get("limit") ?? "25",
    cursor: search.get("cursor") ?? undefined,
  });
  if (!parsed.success)
    return Response.json({ error: "Invalid connector history query." }, { status: 400, headers });

  const cursor = parsed.data.cursor === undefined ? undefined : readCursor(parsed.data.cursor);
  if (parsed.data.cursor !== undefined && cursor === undefined)
    return Response.json({ error: "Invalid connector history cursor." }, { status: 400, headers });

  const { data, error } = await createSupabaseAdminClient().rpc(
    "list_factory_connector_deliveries",
    {
      ...context.scope,
      p_lane: parsed.data.lane,
      p_limit: parsed.data.limit,
      ...(cursor && {
        p_before_at: cursor.recordedAt,
        p_before_kind: cursor.kind,
        p_before_id: cursor.id,
      }),
    },
  );
  if (error) {
    return Response.json(
      { error: "Connector delivery history is unavailable." },
      { status: factoryErrorStatus(error.code), headers },
    );
  }

  const result = connectorDeliveryProjectionSchema.safeParse(data);
  if (!result.success) {
    return Response.json(
      { error: "Connector delivery history is unavailable." },
      { status: 500, headers },
    );
  }

  return Response.json(
    {
      ...result.data,
      nextCursor: result.data.nextCursor
        ? Buffer.from(JSON.stringify(result.data.nextCursor)).toString("base64url")
        : null,
    },
    { headers },
  );
}
