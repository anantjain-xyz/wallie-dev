import { z } from "zod";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import {
  applyScorerGovernance,
  readScorerCalibration,
} from "@/lib/factory-evaluations/scorer-governance";
import {
  calibrationCandidateCursorSchema,
  calibrationCandidatePageSchema,
  scorerGovernanceCommandSchema,
} from "@/lib/factory-evaluations/scorer-governance-contracts";
import {
  handleScorerGovernanceCommand,
  scorerGovernanceFailure,
} from "@/lib/factory-evaluations/scorer-governance-http";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; scorerId: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const target = z
    .string()
    .uuid()
    .safeParse((await params).scorerId);
  const search = new URL(request.url).searchParams;
  const cursor = calibrationCandidateCursorSchema.safeParse(Object.fromEntries(search));
  if (!target.success || !cursor.success || search.size !== 2) {
    return Response.json(
      { error: "Provide a valid calibration case cursor." },
      { status: 400, headers },
    );
  }
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const result = await readScorerCalibration(
      context.access.supabase,
      {
        workspaceId: context.access.workspace.id,
        factoryId: context.factoryId,
      },
      target.data,
      cursor.data,
    );
    return Response.json(calibrationCandidatePageSchema.parse(result), { headers });
  } catch (error) {
    return scorerGovernanceFailure(error, "Could not load calibration cases.");
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  return handleScorerGovernanceCommand(
    request,
    params,
    (await params).scorerId,
    scorerGovernanceCommandSchema,
    applyScorerGovernance,
  );
}
