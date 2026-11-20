import { z } from "zod";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { readFactoryEvaluationReceipts } from "@/lib/factory-evaluations/evaluation-receipts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; evaluationId: string }>;
};
const idSchema = z.string().uuid();

export async function GET(_request: Request, { params }: RouteContext) {
  const evaluationId = idSchema.safeParse((await params).evaluationId);
  if (!evaluationId.success) {
    return Response.json({ error: "Invalid evaluation ID." }, { status: 400, headers });
  }

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;

    const evaluation = await readFactoryEvaluationReceipts(createSupabaseAdminClient(), {
      workspaceId: context.access.workspace.id,
      factoryId: context.factoryId,
      evaluationId: evaluationId.data,
      actorUserId: context.access.user.id,
    });
    if (!evaluation) {
      return Response.json({ error: "Evaluation not found." }, { status: 404, headers });
    }
    return Response.json({ evaluation }, { headers });
  } catch {
    return Response.json({ error: "Could not load the evaluation." }, { status: 500, headers });
  }
}
