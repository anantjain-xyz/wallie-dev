import { z } from "zod";

import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { configureFactoryEvaluationLaneSchema } from "@/lib/factory-evaluations/evaluation-control-contracts";
import {
  configureFactoryEvaluationLane,
  evaluationControlErrorStatus,
  getFactoryEvaluationLane,
} from "@/lib/factory-evaluations/evaluation-controls";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };
const idSchema = z.string().uuid();

async function laneAccess(params: RouteContext["params"]) {
  const id = idSchema.safeParse((await params).workspaceId);
  if (!id.success) {
    return {
      ok: false as const,
      response: Response.json({ error: "Invalid workspace ID." }, { status: 400, headers }),
    };
  }
  const access = await requireWorkspaceAccessById(id.data, { requireManager: true });
  if (!access.ok) {
    return {
      ok: false as const,
      response: Response.json({ error: access.error }, { status: access.status, headers }),
    };
  }
  return {
    ok: true as const,
    workspaceId: access.context.workspace.id,
    actorUserId: access.context.user.id,
  };
}

function laneFailure(error: unknown, fallback: string) {
  const status = evaluationControlErrorStatus(error);
  const messages: Partial<Record<typeof status, string>> = {
    403: "Workspace admin access is required.",
    404: "Workspace not found.",
    409: "The evaluation lane changed. Reload before saving.",
    422: "Invalid evaluation lane settings.",
  };
  return Response.json({ error: messages[status] ?? fallback }, { status, headers });
}

export async function GET(_request: Request, { params }: RouteContext) {
  const access = await laneAccess(params);
  if (!access.ok) return access.response;
  try {
    const lane = await getFactoryEvaluationLane(createSupabaseAdminClient(), access);
    return Response.json({ lane }, { headers });
  } catch (error) {
    return laneFailure(error, "Could not load the evaluation lane.");
  }
}

export async function PUT(request: Request, { params }: RouteContext) {
  const access = await laneAccess(params);
  if (!access.ok) return access.response;
  const command = configureFactoryEvaluationLaneSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!command.success) {
    return Response.json(
      { error: "Provide the current revision, pause state, and concurrency limit from 1 to 16." },
      { status: 400, headers },
    );
  }
  try {
    const lane = await configureFactoryEvaluationLane(createSupabaseAdminClient(), {
      ...access,
      ...command.data,
    });
    return Response.json({ lane }, { headers });
  } catch (error) {
    return laneFailure(error, "Could not save the evaluation lane.");
  }
}
