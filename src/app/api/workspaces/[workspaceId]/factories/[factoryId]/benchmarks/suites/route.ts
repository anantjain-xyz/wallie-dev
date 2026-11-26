import {
  benchmarkSuiteMutationResultSchema,
  saveBenchmarkSuiteSchema,
} from "@/lib/factory-benchmarks/curation-contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";

import { benchmarkMutationFailure, readBenchmarkCommand } from "../mutation-responses";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };
type SuiteRevision = Pick<
  Tables<"factory_benchmark_suite_revisions">,
  "id" | "suite_id" | "revision_number"
>;

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const command = await readBenchmarkCommand(
      request,
      saveBenchmarkSuiteSchema,
      "Provide a suite name, purpose, and a valid task selection.",
    );
    if (!command.ok) return command.response;

    const { name, purpose, selection, suiteId, expectedRevisionId, allowEmpty } = command.data;
    const { data, error } = await createSupabaseAdminClient()
      .rpc("curate_factory_benchmark_suite", {
        p_workspace_id: context.workspaceId,
        p_factory_id: context.factoryId,
        p_actor_user_id: context.access.user.id,
        p_name: name,
        p_purpose: purpose,
        ...(allowEmpty ? { p_allow_empty: true } : {}),
        ...(suiteId ? { p_suite_id: suiteId, p_expected_revision_id: expectedRevisionId } : {}),
        ...(selection.kind === "explicit"
          ? { p_task_revision_ids: selection.taskRevisionIds }
          : selection.kind === "tags"
            ? {
                p_selection_tags: selection.tags,
                ...(selection.previewTaskRevisionIds
                  ? { p_preview_task_revision_ids: selection.previewTaskRevisionIds }
                  : {}),
              }
            : { p_preserve_selection: true }),
      })
      .single<SuiteRevision>();
    if (error?.code === "PT412") {
      return Response.json(
        {
          error:
            "Tag matches changed while you were editing. Refresh the preview and review it before saving.",
        },
        { headers, status: 412 },
      );
    }
    if (error?.code === "PT428") {
      return Response.json(
        { error: "Confirm that you want to save a suite with no tasks." },
        { headers, status: 428 },
      );
    }
    if (error) throw error;
    const result = benchmarkSuiteMutationResultSchema.parse({
      suiteId: data.suite_id,
      revisionId: data.id,
      revisionNumber: data.revision_number,
    });
    return Response.json(result, { headers });
  } catch (error) {
    return benchmarkMutationFailure("suite", error);
  }
}
