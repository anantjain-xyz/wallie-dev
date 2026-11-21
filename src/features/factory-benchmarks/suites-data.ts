import "server-only";

import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { resolveFactorySelection } from "@/features/factories/factory-selection";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import type { Tables } from "@/lib/supabase/database.types";

const suiteFields = "id,suite_id,name,purpose,revision_number,selection_tags,created_at";
const taskChoiceFields = "id,task_id,name,revision_number,tags,replay_eligibility";
const taskFields = `${taskChoiceFields},acceptance_criteria,eligibility_reason` as const;
const pageSize = 30;
const scanPageSize = 200;

export type BenchmarkTaskChoice = Pick<
  Tables<"factory_benchmark_task_revisions">,
  "id" | "task_id" | "name" | "revision_number" | "tags" | "replay_eligibility"
>;
export type BenchmarkTaskRevision = BenchmarkTaskChoice &
  Pick<Tables<"factory_benchmark_task_revisions">, "acceptance_criteria" | "eligibility_reason">;

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
  const selected = resolveFactorySelection(
    factories,
    requested ?? factories.find(({ isDefault }) => isDefault)?.id ?? factories[0]?.id,
  );
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

export async function loadBenchmarkSuites(
  { supabase, workspaceId, factory }: Scope,
  after?: string,
) {
  const query = supabase
    .from("factory_benchmark_suites")
    .select(`id,factory_benchmark_suite_revisions(${suiteFields})`)
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factory.id)
    .order("id")
    .order("revision_number", {
      referencedTable: "factory_benchmark_suite_revisions",
      ascending: false,
    })
    .limit(1, { referencedTable: "factory_benchmark_suite_revisions" })
    .limit(pageSize + 1);
  const { data, error } = await (after ? query.gt("id", after) : query);
  if (error) throw error;
  const page = data.slice(0, pageSize);
  return {
    suites: page.flatMap(({ factory_benchmark_suite_revisions: revisions }) => revisions),
    nextAfter: data.length > pageSize ? page.at(-1)?.id : undefined,
  };
}

export async function loadBenchmarkTaskChoices({ supabase, workspaceId, factory }: Scope) {
  const choices: BenchmarkTaskChoice[] = [];
  let after: string | undefined;
  do {
    const query = supabase
      .from("factory_benchmark_tasks")
      .select(`id,factory_benchmark_task_revisions(${taskChoiceFields})`)
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
    choices.push(...data.flatMap(({ factory_benchmark_task_revisions: revisions }) => revisions));
    after = data.length === scanPageSize ? data.at(-1)?.id : undefined;
  } while (after);
  return choices.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

type BenchmarkMember = BenchmarkTaskRevision & { sourceRunId: string };

async function loadBenchmarkMembers({ supabase, workspaceId, factory }: Scope, revisionId: string) {
  const members: BenchmarkMember[] = [];
  let after: string | undefined;
  do {
    const query = supabase
      .from("factory_benchmark_suite_members")
      .select(
        `task_id,revision:factory_benchmark_task_revisions!inner(${taskFields},task:factory_benchmark_tasks!inner(source_run_id))`,
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
      members.push({ ...member, sourceRunId: task.source_run_id });
    }
    after = data.length === scanPageSize ? data.at(-1)?.task_id : undefined;
  } while (after);
  return members.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

async function loadLatestMemberTasks(
  { supabase, workspaceId, factory }: Scope,
  members: BenchmarkMember[],
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
