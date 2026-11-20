import { z } from "zod";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import {
  cancelFactoryEvaluationJob,
  evaluationControlErrorStatus,
} from "@/lib/factory-evaluations/evaluation-controls";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; evaluationId: string }>;
};
const idSchema = z.string().uuid();

export async function POST(_request: Request, { params }: RouteContext) {
  const evaluationId = idSchema.safeParse((await params).evaluationId);
  if (!evaluationId.success) {
    return Response.json({ error: "Invalid evaluation ID." }, { status: 400, headers });
  }
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  try {
    const evaluation = await cancelFactoryEvaluationJob(createSupabaseAdminClient(), {
      workspaceId: context.access.workspace.id,
      factoryId: context.factoryId,
      evaluationId: evaluationId.data,
      actorUserId: context.access.user.id,
    });
    return Response.json({ evaluation }, { headers });
  } catch (error) {
    const status = evaluationControlErrorStatus(error);
    const messages: Partial<Record<typeof status, string>> = {
      403: "Factory manager access is required.",
      404: "Evaluation not found.",
    };
    return Response.json(
      { error: messages[status] ?? "Could not cancel the evaluation." },
      { status, headers },
    );
  }
}
