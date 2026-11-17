import { z } from "zod";

import { createFactoryAgentSchema } from "@/lib/factory-agents/contracts";
import {
  factoryAgentResponseHeaders as headers,
  resolveFactoryAgentRouteContext,
} from "@/lib/factory-agents/route-context";
import { createFactoryAgent, listFactoryAgents } from "@/lib/factory-agents/service";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };
const querySchema = z
  .object({
    afterId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryAgentRouteContext(params);
  if (!context.ok) return context.response;
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success)
    return Response.json({ error: "Invalid agent list request." }, { status: 400, headers });
  const result = await listFactoryAgents(context.access.supabase, { ...context, ...query.data });
  return Response.json(result, { headers });
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryAgentRouteContext(params);
  if (!context.ok) return context.response;
  const command = createFactoryAgentSchema.safeParse(await request.json().catch(() => null));
  if (!command.success)
    return Response.json(
      { error: "Provide an agent name, slug, and valid prompt." },
      { status: 400, headers },
    );
  try {
    const revision = await createFactoryAgent(createSupabaseAdminClient(), {
      ...context,
      actorUserId: context.access.user.id,
      ...command.data,
    });
    return Response.json({ revision }, { status: 201, headers });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return Response.json(
      { error: "Could not create the agent." },
      {
        status: factoryErrorStatus(typeof code === "string" ? code : undefined),
        headers,
      },
    );
  }
}
