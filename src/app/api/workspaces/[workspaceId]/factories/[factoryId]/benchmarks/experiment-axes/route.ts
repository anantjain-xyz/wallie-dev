import { BenchmarkExperimentError } from "@/lib/factory-benchmarks/experiment";
import { freezeBenchmarkExperimentAxes } from "@/lib/factory-benchmarks/experiment-axes";
import { freezeBenchmarkAxesRequestSchema } from "@/lib/factory-benchmarks/experiment-axes-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { readBenchmarkCommand } from "../mutation-responses";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const command = await readBenchmarkCommand(
      request,
      freezeBenchmarkAxesRequestSchema,
      "Check the comparison configurations, replay policy, and any scoring settings.",
    );
    if (!command.ok) return command.response;
    const snapshot = await freezeBenchmarkExperimentAxes({
      admin: createSupabaseAdminClient(),
      workspaceId: context.workspaceId,
      factoryId: context.factoryId,
      actorUserId: context.access.user.id,
      request: command.data,
      signal: request.signal,
    });
    return Response.json(snapshot, { headers });
  } catch (error) {
    if (error instanceof BenchmarkExperimentError) {
      return Response.json({ error: error.message }, { status: error.status, headers });
    }
    return Response.json({ error: "The comparison could not be saved." }, { status: 500, headers });
  }
}
