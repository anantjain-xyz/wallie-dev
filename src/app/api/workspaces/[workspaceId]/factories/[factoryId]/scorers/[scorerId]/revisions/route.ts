import { z } from "zod";

import { saveFactoryScorerRevisionSchema } from "@/lib/factory-scorers/authoring-contracts";
import {
  listFactoryScorerRevisions,
  saveFactoryScorerRevision,
} from "@/lib/factory-scorers/service";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { readScorerCommand, scorerWriteFailure } from "../../route-responses";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; scorerId: string }>;
};
const uuid = z.string().uuid();
const querySchema = z.strictObject({
  beforeRevisionNumber: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const scorerId = uuid.safeParse((await params).scorerId);
  const query = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!scorerId.success || !query.success) {
    return Response.json({ error: "Invalid scorer history request." }, { status: 400, headers });
  }
  const result = await listFactoryScorerRevisions(context.access.supabase, {
    ...context,
    scorerId: scorerId.data,
    ...query.data,
  });
  return Response.json(result, { headers });
}

export async function POST(request: Request, { params }: RouteContext) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  const scorerId = uuid.safeParse((await params).scorerId);
  if (!scorerId.success) {
    return Response.json({ error: "Provide a valid scorer ID." }, { status: 400, headers });
  }
  const command = await readScorerCommand(
    request,
    saveFactoryScorerRevisionSchema,
    "Provide the current revision number and a valid scorer rubric.",
  );
  if (!command.ok) return command.response;
  try {
    const revision = await saveFactoryScorerRevision(createSupabaseAdminClient(), {
      ...context,
      actorUserId: context.access.user.id,
      scorerId: scorerId.data,
      ...command.data,
    });
    return Response.json({ revision }, { status: 201, headers });
  } catch (error) {
    return scorerWriteFailure(error);
  }
}
