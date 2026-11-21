import { z } from "zod";

import {
  benchmarkEvaluationPageQuerySchema,
  benchmarkEvaluationPageSchema,
} from "@/lib/factory-benchmarks/evaluation-outcomes-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = {
  params: Promise<{ workspaceId: string; factoryId: string; experimentId: string }>;
};

export async function GET(request: Request, { params }: Context) {
  try {
    const { workspaceId, factoryId, experimentId: rawExperimentId } = await params;
    const experimentId = z.string().uuid().toLowerCase().safeParse(rawExperimentId);
    const query = benchmarkEvaluationPageQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!experimentId.success || !query.success) {
      return Response.json(
        { error: "Provide a valid experiment and page cursor." },
        { status: 400, headers },
      );
    }
    const context = await resolveFactoryRouteContext(Promise.resolve({ workspaceId, factoryId }));
    if (!context.ok) return context.response;
    const { afterTrialId, afterScorerRevisionId, limit = 50 } = query.data;
    const { data, error } = await createSupabaseAdminClient()
      .rpc("read_factory_benchmark_evaluation", {
        p_workspace_id: context.workspaceId,
        p_factory_id: context.factoryId,
        p_experiment_id: experimentId.data,
        p_actor_user_id: context.access.user.id,
        ...(afterTrialId
          ? { p_after_trial_id: afterTrialId, p_after_scorer_revision_id: afterScorerRevisionId }
          : {}),
        p_limit: limit,
      })
      .abortSignal(request.signal);
    if (error?.code === "42501") {
      return Response.json(
        { error: "Factory manager access is required." },
        { status: 403, headers },
      );
    }
    if (error?.code === "P0002") {
      return Response.json(
        { error: "The benchmark evaluation is unavailable." },
        { status: 404, headers },
      );
    }
    if (error) throw error;
    const page = benchmarkEvaluationPageSchema.parse(data);
    if (page.experimentId !== experimentId.data || page.cells.length > limit) {
      throw new Error("The benchmark evaluation page did not match the request.");
    }
    return Response.json(page, { headers });
  } catch {
    return Response.json(
      { error: "Could not load benchmark evaluations." },
      { status: 500, headers },
    );
  }
}
