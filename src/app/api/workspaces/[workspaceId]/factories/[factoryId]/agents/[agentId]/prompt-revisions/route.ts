import { z } from "zod";

import { saveFactoryAgentPromptSchema } from "@/lib/factory-agents/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import {
  listFactoryAgentPromptRevisions,
  saveFactoryAgentPromptRevision,
} from "@/lib/factory-agents/service";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; agentId: string }>;
};
const uuid = z.string().uuid();
const querySchema = z
  .object({
    beforeRevisionNumber: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const agentId = uuid.safeParse((await params).agentId);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!agentId.success || !query.success)
    return Response.json({ error: "Invalid agent revision request." }, { status: 400, headers });
  const result = await listFactoryAgentPromptRevisions(context.access.supabase, {
    ...context,
    agentId: agentId.data,
    ...query.data,
  });
  return Response.json(result, { headers });
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const agentId = uuid.safeParse((await params).agentId);
  const command = saveFactoryAgentPromptSchema.safeParse(await request.json().catch(() => null));
  if (!agentId.success || !command.success)
    return Response.json(
      { error: "Provide an agent ID, expected revision, and valid prompt." },
      { status: 400, headers },
    );
  try {
    const revision = await saveFactoryAgentPromptRevision(createSupabaseAdminClient(), {
      ...context,
      actorUserId: context.access.user.id,
      agentId: agentId.data,
      ...command.data,
    });
    return Response.json({ revision }, { status: 201, headers });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return Response.json(
      { error: "Could not save the agent prompt revision." },
      {
        status: factoryErrorStatus(typeof code === "string" ? code : undefined),
        headers,
      },
    );
  }
}
