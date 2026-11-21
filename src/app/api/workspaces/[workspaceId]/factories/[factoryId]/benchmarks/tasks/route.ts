import {
  benchmarkTaskMutationResultSchema,
  saveBenchmarkTaskSchema,
} from "@/lib/factory-benchmarks/curation-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";

import { benchmarkMutationFailure, readBenchmarkCommand } from "../mutation-responses";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };
type TaskRevision = Pick<
  Tables<"factory_benchmark_task_revisions">,
  "id" | "task_id" | "revision_number"
>;

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const command = await readBenchmarkCommand(
      request,
      saveBenchmarkTaskSchema,
      "Provide a task name, acceptance criteria, tags, and the current revision.",
    );
    if (!command.ok) return command.response;

    const { taskId, expectedRevisionId, name, acceptanceCriteria, tags } = command.data;
    const { data: base, error: readError } = await context.access.supabase
      .from("factory_benchmark_task_revisions")
      .select("id, replay_eligibility, eligibility_reason")
      .eq("workspace_id", context.workspaceId)
      .eq("factory_id", context.factoryId)
      .eq("task_id", taskId)
      .order("revision_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readError) throw readError;
    if (!base) return benchmarkMutationFailure("task", { code: "P0002" });
    if (base.id !== expectedRevisionId) return benchmarkMutationFailure("task", { code: "PT409" });

    const { data, error } = await createSupabaseAdminClient()
      .rpc("save_factory_benchmark_task_revision", {
        p_workspace_id: context.workspaceId,
        p_factory_id: context.factoryId,
        p_actor_user_id: context.access.user.id,
        p_task_id: taskId,
        p_expected_revision_id: expectedRevisionId,
        p_name: name,
        p_acceptance_criteria: acceptanceCriteria,
        p_tags: tags,
        p_replay_eligibility: base.replay_eligibility,
        ...(base.eligibility_reason === null
          ? {}
          : { p_eligibility_reason: base.eligibility_reason }),
      })
      .single<TaskRevision>();
    if (error) throw error;
    const result = benchmarkTaskMutationResultSchema.parse({
      taskId: data.task_id,
      revisionId: data.id,
      revisionNumber: data.revision_number,
    });
    return Response.json(result, { headers });
  } catch (error) {
    return benchmarkMutationFailure("task", error);
  }
}
