import { z } from "zod";

import { createFactoryScorerSchema } from "@/lib/factory-scorers/authoring-contracts";
import { createFactoryScorer, listFactoryScorers } from "@/lib/factory-scorers/service";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { readScorerCommand, scorerWriteFailure } from "./route-responses";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };
const querySchema = z.strictObject({
  afterId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) {
    return Response.json({ error: "Invalid scorer list request." }, { status: 400, headers });
  }
  const result = await listFactoryScorers(context.access.supabase, { ...context, ...query.data });
  return Response.json(result, { headers });
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const command = await readScorerCommand(
    request,
    createFactoryScorerSchema,
    "Enter a name and a valid scorer rubric. A custom identifier is optional.",
  );
  if (!command.ok) return command.response;
  try {
    const revision = await createFactoryScorer(createSupabaseAdminClient(), {
      ...context,
      actorUserId: context.access.user.id,
      ...command.data,
    });
    return Response.json({ revision }, { status: 201, headers });
  } catch (error) {
    return scorerWriteFailure(error);
  }
}
