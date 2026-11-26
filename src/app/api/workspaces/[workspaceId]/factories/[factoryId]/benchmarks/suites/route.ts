import { z } from "zod";

import { loadBenchmarkTaskChoices } from "@/features/factory-benchmarks/suites-data";
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

const refreshQuery = z
  .object({
    suiteId: z.string().uuid().optional(),
    expectedRevisionId: z.string().uuid().optional(),
  })
  .refine(({ suiteId, expectedRevisionId }) => Boolean(suiteId) === Boolean(expectedRevisionId));

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const search = new URL(request.url).searchParams;
    const query = refreshQuery.safeParse({
      suiteId: search.get("suiteId") ?? undefined,
      expectedRevisionId: search.get("expectedRevisionId") ?? undefined,
    });
    if (!query.success) {
      return Response.json(
        { error: "Provide the suite and its expected revision together." },
        { status: 400, headers },
      );
    }

    const {
      workspaceId,
      factoryId,
      access: { supabase },
    } = context;
    if (query.data.suiteId) {
      const { data: latest, error } = await supabase
        .from("factory_benchmark_suite_revisions")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("suite_id", query.data.suiteId)
        .order("revision_number", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!latest) {
        return Response.json(
          { error: "The benchmark suite is unavailable in this factory." },
          { status: 404, headers },
        );
      }
      if (latest.id !== query.data.expectedRevisionId) {
        return Response.json(
          { error: "The benchmark suite changed. Reload the latest revision before saving." },
          { status: 409, headers },
        );
      }
    }
    const taskChoices = await loadBenchmarkTaskChoices({
      workspaceId,
      factory: { id: factoryId },
      supabase,
    });
    return Response.json({ taskChoices }, { headers });
  } catch {
    return Response.json(
      { error: "Could not refresh the benchmark task preview. Try again." },
      { status: 500, headers },
    );
  }
}

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
