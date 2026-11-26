import "server-only";

import { z } from "zod";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveFactorySelection } from "@/features/factories/factory-selection";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import type { Json, Tables } from "@/lib/supabase/database.types";

const suiteFields = "id,suite_id,name,purpose,revision_number,selection_tags,created_at";
const taskFields =
  "id,task_id,name,revision_number,tags,replay_eligibility,acceptance_criteria,eligibility_reason";
const pageSize = 30;
const scanPageSize = 200;

export type BenchmarkTaskRevision = Pick<
  Tables<"factory_benchmark_task_revisions">,
  | "id"
  | "task_id"
  | "name"
  | "revision_number"
  | "tags"
  | "replay_eligibility"
  | "acceptance_criteria"
  | "eligibility_reason"
>;
export type BenchmarkTaskSource = {
  runId: string;
  title: string;
  stage: string | null;
  createdAt: string;
  attempt?: number;
  commit?: string;
};
export type BenchmarkTaskChoice = BenchmarkTaskRevision & { source: BenchmarkTaskSource | null };

type TaskWithProvenance = BenchmarkTaskRevision & {
  sourceRunId: string;
  provenance: Json;
};
const sourceProvenance = z.object({
  attempt: z.number().int().positive().nullish(),
  inputSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/i)
    .nullish(),
});

export async function loadBenchmarkScope(
  workspaceSlug: string,
  factoryQuery?: string | string[],
  suiteId?: string,
) {
  const [{ workspace, supabase }, factories] = await Promise.all([
    loadAuthenticatedWorkspaceContext(workspaceSlug),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  let requested = factoryQuery;
  if (requested === undefined && suiteId) {
    const { data, error } = await supabase
      .from("factory_benchmark_suites")
      .select("factory_id")
      .eq("workspace_id", workspace.id)
      .eq("id", suiteId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    requested = data.factory_id;
  }
  const selected = resolveFactorySelection(factories, requested, { useFirstVisible: true });
  if (selected.kind !== "factory") return null;
  const { factory } = selected;
  return {
    factory,
    workspaceId: workspace.id,
    supabase,
    canEdit: factory.status === "active" && factory.canManage === true,
  };
}

type Scope = NonNullable<Awaited<ReturnType<typeof loadBenchmarkScope>>>;

export async function hasBenchmarkTasks({ supabase, workspaceId, factory }: Scope) {
  const { data, error } = await supabase
    .from("factory_benchmark_tasks")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factory.id)
    .limit(1);
  if (error) throw error;
  return data.length > 0;
}

export async function loadBenchmarkSuites(
  { supabase, workspaceId, factory }: Scope,
  { after, name, purpose }: { after?: string; name?: string; purpose?: string },
) {
  const { data, error } = await supabase.rpc("list_factory_benchmark_suites", {
    p_workspace_id: workspaceId,
    p_factory_id: factory.id,
    ...(after ? { p_after: after } : {}),
    ...(name ? { p_name: name } : {}),
    ...(purpose ? { p_purpose: purpose } : {}),
  });
  if (error) throw error;
  const suites = data.slice(0, pageSize);
  return {
    suites,
    nextAfter: data.length > pageSize ? suites.at(-1)?.suite_id : undefined,
  };
}

export async function loadBenchmarkTaskChoices(scope: Scope) {
  const { supabase, workspaceId, factory } = scope;
  const choices: TaskWithProvenance[] = [];
  let after: string | undefined;
  do {
    const query = supabase
      .from("factory_benchmark_tasks")
      .select(`id,source_run_id,source_provenance,factory_benchmark_task_revisions(${taskFields})`)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .order("id")
      .order("revision_number", {
        referencedTable: "factory_benchmark_task_revisions",
        ascending: false,
      })
      .limit(1, { referencedTable: "factory_benchmark_task_revisions" })
      .limit(scanPageSize);
    const { data, error } = await (after ? query.gt("id", after) : query);
    if (error) throw error;
    choices.push(
      ...data.flatMap(
        ({ source_run_id, source_provenance, factory_benchmark_task_revisions: revisions }) =>
          revisions.map((revision) => ({
            ...revision,
            sourceRunId: source_run_id,
            provenance: source_provenance,
          })),
      ),
    );
    after = data.length === scanPageSize ? data.at(-1)?.id : undefined;
  } while (after);
  return loadTaskSources(scope, choices);
}

async function loadBenchmarkMembers(scope: Scope, revisionId: string) {
  const { supabase, workspaceId, factory } = scope;
  const members: TaskWithProvenance[] = [];
  let after: string | undefined;
  do {
    const query = supabase
      .from("factory_benchmark_suite_members")
      .select(
        `task_id,revision:factory_benchmark_task_revisions!inner(${taskFields},task:factory_benchmark_tasks!inner(source_run_id,source_provenance))`,
      )
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .eq("suite_revision_id", revisionId)
      .order("task_id")
      .limit(scanPageSize);
    const { data, error } = await (after ? query.gt("task_id", after) : query);
    if (error) throw error;
    for (const { revision } of data) {
      const { task, ...member } = revision;
      members.push({
        ...member,
        sourceRunId: task.source_run_id,
        provenance: task.source_provenance,
      });
    }
    after = data.length === scanPageSize ? data.at(-1)?.task_id : undefined;
  } while (after);
  return loadTaskSources(scope, members);
}

async function loadTaskSources(
  { supabase, workspaceId, factory }: Scope,
  tasks: TaskWithProvenance[],
) {
  const sources = new Map<string, Omit<BenchmarkTaskSource, "attempt" | "commit">>();
  const runIds = [...new Set(tasks.map(({ sourceRunId }) => sourceRunId))];
  for (let offset = 0; offset < runIds.length; offset += 50) {
    const { data, error } = await supabase
      .from("agent_runs")
      .select("id,stage_name,stage_slug,created_at,sessions!inner(title,factory_id)")
      .eq("workspace_id", workspaceId)
      .eq("sessions.factory_id", factory.id)
      .in("id", runIds.slice(offset, offset + 50));
    if (error) throw error;
    for (const { id, stage_name, stage_slug, created_at, sessions } of data) {
      sources.set(id, {
        runId: id,
        stage: stage_name || stage_slug,
        createdAt: created_at,
        title: sessions.title,
      });
    }
  }
  return tasks
    .map(({ sourceRunId, provenance, ...task }): BenchmarkTaskChoice => {
      const source = sources.get(sourceRunId);
      const pins = source ? sourceProvenance.safeParse(provenance).data : undefined;
      return {
        ...task,
        name:
          task.name === `Historical run ${sourceRunId.slice(0, 8)}`
            ? (source?.title ?? "Historical run")
            : task.name,
        source: source
          ? { ...source, attempt: pins?.attempt ?? undefined, commit: pins?.inputSha ?? undefined }
          : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function loadLatestMemberTasks(
  { supabase, workspaceId, factory }: Scope,
  members: BenchmarkTaskChoice[],
) {
  const result = new Map<string, BenchmarkTaskRevision>();
  const batchSize = 50;
  for (let offset = 0; offset < members.length; offset += batchSize) {
    const { data, error } = await supabase
      .from("factory_benchmark_tasks")
      .select(`factory_benchmark_task_revisions(${taskFields})`)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .in(
        "id",
        members.slice(offset, offset + batchSize).map(({ task_id }) => task_id),
      )
      .order("revision_number", {
        referencedTable: "factory_benchmark_task_revisions",
        ascending: false,
      })
      .limit(1, { referencedTable: "factory_benchmark_task_revisions" });
    if (error) throw error;
    for (const {
      factory_benchmark_task_revisions: [latest],
    } of data) {
      if (latest) result.set(latest.task_id, latest);
    }
  }
  return result;
}

export async function loadBenchmarkSuiteDetail(
  scope: Scope,
  {
    suiteId,
    revisionId,
    before,
    edit,
  }: { suiteId: string; revisionId?: string; before?: number; edit: boolean },
) {
  const { supabase, workspaceId, factory, canEdit } = scope;
  const revisionsQuery = () =>
    supabase
      .from("factory_benchmark_suite_revisions")
      .select(suiteFields)
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factory.id)
      .eq("suite_id", suiteId);
  const page = revisionsQuery()
    .order("revision_number", { ascending: false })
    .limit(pageSize + 1);
  const [history, current, exact] = await Promise.all([
    before ? page.lt("revision_number", before) : page,
    before
      ? revisionsQuery().order("revision_number", { ascending: false }).limit(1).maybeSingle()
      : null,
    revisionId ? revisionsQuery().eq("id", revisionId).maybeSingle() : null,
  ]);
  if (history.error) throw history.error;
  if (current?.error) throw current.error;
  if (exact?.error) throw exact.error;
  const revisions = history.data.slice(0, pageSize);
  const latest = current ? current.data : revisions[0];
  const selected = exact ? exact.data : latest;
  if (!latest || !selected) return null;

  const editable = canEdit && latest.id === selected.id;
  const [members, choices] = await Promise.all([
    loadBenchmarkMembers(scope, selected.id),
    editable && edit ? loadBenchmarkTaskChoices(scope) : [],
  ]);
  return {
    selected,
    editable,
    latest,
    revisions,
    members,
    choices,
    nextBefore: history.data.length > pageSize ? revisions.at(-1)?.revision_number : undefined,
    latestTasks: editable
      ? await loadLatestMemberTasks(scope, members)
      : new Map<string, BenchmarkTaskRevision>(),
  };
}
