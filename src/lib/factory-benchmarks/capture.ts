import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { WorkspaceAccessContext } from "@/lib/workspaces/access";

import {
  benchmarkCapturePreviewSchema,
  benchmarkCaptureResultSchema,
  type BenchmarkCaptureRequest,
} from "./capture-contracts";
import { loadBenchmarkSource } from "./capture-evidence";

export class BenchmarkCaptureError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

export async function resolveBenchmarkCapture(access: WorkspaceAccessContext, runId: string) {
  const { supabase, workspace, currentMember } = access;
  const { data: run, error } = await supabase
    .from("agent_runs")
    .select(
      "id, session_id, agent_job_id, attempt_count, status, finished_at, sessions!inner(factory_id)",
    )
    .eq("workspace_id", workspace.id)
    .eq("sessions.workspace_id", workspace.id)
    .eq("id", runId)
    .maybeSingle();
  if (error) throw error;
  if (!run) throw new BenchmarkCaptureError(404, "Run not found.");

  const factoryId = run.sessions.factory_id;
  const { data: factory, error: factoryError } = await supabase
    .from("factories")
    .select("status, factory_members!factory_members_workspace_factory_fkey(role)")
    .eq("workspace_id", workspace.id)
    .eq("id", factoryId)
    .eq("factory_members.member_id", currentMember.id)
    .eq("factory_members.role", "manager")
    .is("factory_members.revoked_at", null)
    .maybeSingle();
  if (factoryError) throw factoryError;
  if (!factory) throw new BenchmarkCaptureError(404, "Run not found.");

  const workspaceManager = currentMember.role === "owner" || currentMember.role === "admin";
  if (!workspaceManager && factory.factory_members.length === 0) {
    throw new BenchmarkCaptureError(
      403,
      "Factory manager access is required to capture a benchmark.",
    );
  }
  if (factory.status !== "active")
    throw new BenchmarkCaptureError(409, "This factory is archived.");
  if (!run.finished_at || !["success", "error", "canceled"].includes(run.status)) {
    throw new BenchmarkCaptureError(422, "Only finished runs can be added to a benchmark.");
  }

  return { access, factoryId, run, admin: createSupabaseAdminClient() };
}

type CaptureScope = Awaited<ReturnType<typeof resolveBenchmarkCapture>>;

async function readSuites(scope: CaptureScope) {
  const { data, error } = await scope.access.supabase
    .from("factory_benchmark_suites")
    .select("id, factory_benchmark_suite_revisions(id, name, purpose)")
    .eq("workspace_id", scope.access.workspace.id)
    .eq("factory_id", scope.factoryId)
    .order("created_at", { ascending: false })
    .order("id")
    .order("revision_number", {
      referencedTable: "factory_benchmark_suite_revisions",
      ascending: false,
    })
    .limit(1, { referencedTable: "factory_benchmark_suite_revisions" });
  if (error) throw error;
  return data.flatMap((suite) => {
    const revision = suite.factory_benchmark_suite_revisions[0];
    return revision
      ? [{ id: suite.id, revisionId: revision.id, name: revision.name, purpose: revision.purpose }]
      : [];
  });
}

async function readExistingTask(scope: CaptureScope) {
  const { data, error } = await scope.access.supabase
    .from("factory_benchmark_tasks")
    .select("id, factory_benchmark_task_revisions(acceptance_criteria)")
    .eq("workspace_id", scope.access.workspace.id)
    .eq("factory_id", scope.factoryId)
    .eq("source_run_id", scope.run.id)
    .order("revision_number", {
      referencedTable: "factory_benchmark_task_revisions",
      ascending: false,
    })
    .limit(1, { referencedTable: "factory_benchmark_task_revisions" })
    .maybeSingle();
  if (error) throw error;
  const revision = data?.factory_benchmark_task_revisions[0];
  return data && revision
    ? { id: data.id, acceptanceCriteria: revision.acceptance_criteria }
    : null;
}

export async function loadBenchmarkCapturePreview(scope: CaptureScope) {
  const [source, suites, existingTask] = await Promise.all([
    loadBenchmarkSource(scope),
    readSuites(scope),
    readExistingTask(scope),
  ]);
  return benchmarkCapturePreviewSchema.parse({ source, suites, existingTask });
}

export async function saveBenchmarkCapture(scope: CaptureScope, request: BenchmarkCaptureRequest) {
  const source = await loadBenchmarkSource(scope);
  const { suite } = request;
  const { data, error } = await scope.admin.rpc("capture_factory_benchmark_run", {
    p_workspace_id: scope.access.workspace.id,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.access.user.id,
    p_source_run_id: scope.run.id,
    p_acceptance_criteria: request.acceptanceCriteria ?? "",
    p_task_name:
      Array.from(source.name.trim()).slice(0, 120).join("") ||
      `Historical run ${scope.run.id.slice(0, 8)}`,
    p_replay_eligibility: source.eligibility.status,
    p_suite_id: suite.id,
    ...(source.eligibility.status === "ineligible"
      ? { p_eligibility_reason: source.eligibility.reasons.join(" ") }
      : {}),
    ...(suite.kind === "existing"
      ? { p_expected_revision_id: suite.revisionId }
      : { p_new_suite_name: suite.name, p_new_suite_purpose: suite.purpose }),
  });
  if (error) {
    if (error.code === "42501")
      throw new BenchmarkCaptureError(
        403,
        "Factory manager access is required to capture a benchmark.",
      );
    if (error.code === "P0002")
      throw new BenchmarkCaptureError(404, "The source run or suite is unavailable.");
    if (error.code === "PT409" || error.code === "P0011") {
      throw new BenchmarkCaptureError(
        409,
        "The suite or factory changed. Reload the preview and try again.",
      );
    }
    if (error.code === "22023") {
      throw new BenchmarkCaptureError(
        422,
        "Choose a suite and provide acceptance criteria for a new task.",
      );
    }
    if (error.code === "PT422") {
      throw new BenchmarkCaptureError(422, "The source run or suite is ineligible for capture.");
    }
    throw error;
  }
  return benchmarkCaptureResultSchema.parse(data);
}
