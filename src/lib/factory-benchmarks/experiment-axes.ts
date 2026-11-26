import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import type { Database } from "@/lib/supabase/database.types";

import { benchmarkPublicationTime } from "./comparison-labels";
import {
  benchmarkAxisCatalogSchema,
  benchmarkAxisSnapshotSchema,
  type BenchmarkAxisCatalog,
  type BenchmarkAxisRequest,
} from "./experiment-axes-contracts";
import { matchesBenchmarkEvaluationPlan } from "./experiment-evaluation-contracts";
import { BenchmarkExperimentError } from "./experiment";

type Client = SupabaseClient<Database>;

async function readPages<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
) {
  const rows: T[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) return rows;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

export async function loadBenchmarkDefinitionChoices({
  supabase,
  workspaceId,
  factoryId,
  revisionIds,
  frozenAt,
}: {
  supabase: Client;
  workspaceId: string;
  factoryId: string;
  revisionIds?: string[];
  frozenAt?: string;
}): Promise<BenchmarkAxisCatalog["definitions"]> {
  if (revisionIds?.length === 0) return [];
  const [revisions, activations] = await Promise.all([
    readPages((from, to) => {
      const query = supabase
        .from("factory_definition_revisions")
        .select("id,canonical_digest,definition_json,created_at")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .order("id");
      return (revisionIds ? query.in("id", revisionIds) : query).range(from, to);
    }),
    readPages((from, to) => {
      const query = supabase
        .from("factory_definition_activations")
        .select("revision_id,activation_number")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .order("activation_number");
      if (revisionIds) query.in("revision_id", revisionIds);
      if (frozenAt) query.lte("created_at", frozenAt);
      return query.range(from, to);
    }),
  ]);
  const firstActivation = new Map<string, number>();
  for (const { revision_id, activation_number } of activations) {
    if (!firstActivation.has(revision_id)) firstActivation.set(revision_id, activation_number);
  }
  const currentId = frozenAt ? undefined : activations.at(-1)?.revision_id;
  return revisions.flatMap((revision) => {
    const definition = readVerifiedFactoryDefinition(
      revision.definition_json,
      revision.canonical_digest,
    );
    if (!definition) return [];
    const activation = firstActivation.get(revision.id);
    const stages = definition.stages
      .slice(0, 3)
      .map(({ name }) => name)
      .join(" → ");
    return [
      {
        id: revision.id,
        digest: revision.canonical_digest,
        isCurrent: revision.id === currentId,
        label: [
          activation === undefined ? null : `First activated as ${activation}`,
          `Published ${benchmarkPublicationTime(revision.created_at)}`,
          stages ? `${stages}${definition.stages.length > 3 ? " → …" : ""}` : null,
          `${definition.skillIds.length} ${definition.skillIds.length === 1 ? "skill" : "skills"}`,
        ]
          .filter(Boolean)
          .join(" · "),
      },
    ];
  });
}

async function readExactMetadata<T>(
  ids: string[],
  query: (ids: string[]) => PromiseLike<{ data: T[] | null; error: unknown }>,
) {
  const rows: T[] = [];
  const uniqueIds = [...new Set(ids)];
  for (let start = 0; start < uniqueIds.length; start += 100) {
    const { data, error } = await query(uniqueIds.slice(start, start + 100));
    if (error) throw error;
    if (data) rows.push(...data);
  }
  return rows;
}

export async function loadBenchmarkExperimentAxes({
  supabase,
  admin,
  workspaceId,
  factoryId,
  suiteRevisionId,
}: {
  supabase: Client;
  admin: Client;
  workspaceId: string;
  factoryId: string;
  suiteRevisionId: string;
}): Promise<BenchmarkAxisCatalog> {
  const [definitions, policies, receipts, scorers] = await Promise.all([
    loadBenchmarkDefinitionChoices({ supabase, workspaceId, factoryId }),
    readPages((from, to) =>
      supabase
        .from("factory_benchmark_replay_policy_revisions")
        .select("id,profile,revision_number")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .order("revision_number", { ascending: false })
        .range(from, to),
    ),
    readPages((from, to) =>
      supabase
        .rpc("list_factory_benchmark_axis_profiles", {
          p_workspace_id: workspaceId,
          p_factory_id: factoryId,
          p_suite_revision_id: suiteRevisionId,
        })
        .order("id")
        .order("definition_id")
        .range(from, to),
    ),
    readPages((from, to) =>
      supabase
        .from("factory_scorer_revisions")
        .select("id,revision_number,scorer:factory_scorers!inner(name)")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .order("id")
        .range(from, to),
    ),
  ]);

  const definitionDigests = new Map(definitions.map(({ id, digest }) => [id, digest]));
  const exactReceipts = receipts.filter(
    (receipt) => definitionDigests.get(receipt.definition_id) === receipt.definition_digest,
  );
  const [checks, connections] = await Promise.all([
    readExactMetadata(
      exactReceipts.map(({ id }) => id),
      (ids) =>
        admin
          .from("sandbox_capability_checks")
          .select("id,checked_at,sandbox_connection_revision")
          .eq("workspace_id", workspaceId)
          .in("id", ids),
    ),
    readExactMetadata(
      exactReceipts.map(({ sandbox_connection_revision }) => sandbox_connection_revision),
      (ids) =>
        admin
          .from("workspace_vercel_sandbox_connections")
          .select("connection_revision,project_name")
          .eq("workspace_id", workspaceId)
          .in("connection_revision", ids),
    ),
  ]);
  const checksById = new Map(checks.map((check) => [check.id, check]));
  const connectionsById = new Map(
    connections.map((item) => [item.connection_revision, item.project_name]),
  );
  const profiles = new Map<
    string,
    Omit<
      BenchmarkAxisCatalog["profiles"][number],
      "harness" | "workerRuntime" | "sandboxProvider"
    > & {
      harness: string;
      workerRuntime: string;
      sandboxProvider: string;
    }
  >();
  for (const receipt of exactReceipts) {
    const key = `${receipt.id}:${receipt.worker_runtime}:${receipt.toolchain_digest}:${receipt.unavailable_reason ?? ""}`;
    const check = checksById.get(receipt.id);
    const profile = profiles.get(key) ?? {
      id: receipt.id,
      modelKey: receipt.model_key,
      harness: receipt.harness,
      harnessModel: receipt.harness_model,
      workerRuntime: receipt.worker_runtime,
      sandboxProvider: receipt.sandbox_provider,
      sandboxConnectionRevision: receipt.sandbox_connection_revision,
      toolchain: receipt.toolchain,
      toolchainDigest: receipt.toolchain_digest,
      connectionName: connectionsById.get(receipt.sandbox_connection_revision) ?? null,
      checkedAt:
        check?.sandbox_connection_revision === receipt.sandbox_connection_revision
          ? check.checked_at
          : null,
      definitionIds: [],
      unavailableReason: receipt.unavailable_reason,
    };
    profile.definitionIds.push(receipt.definition_id);
    profiles.set(key, profile);
  }

  return benchmarkAxisCatalogSchema.parse({
    definitions,
    policies: policies.map(({ id, profile, revision_number }) => ({
      id,
      profile,
      revisionNumber: revision_number,
    })),
    scorerRevisions: scorers
      .map(({ id, scorer, revision_number }) => ({
        id,
        scorerName: scorer.name,
        revisionNumber: revision_number,
      }))
      .sort(
        (a, b) =>
          a.scorerName.localeCompare(b.scorerName) ||
          b.revisionNumber - a.revisionNumber ||
          a.id.localeCompare(b.id),
      ),
    profiles: [...profiles.values()],
  });
}

export async function freezeBenchmarkExperimentAxes({
  admin,
  workspaceId,
  factoryId,
  actorUserId,
  request,
  signal,
}: {
  admin: Client;
  workspaceId: string;
  factoryId: string;
  actorUserId: string;
  request: BenchmarkAxisRequest;
  signal: AbortSignal;
}) {
  const args = {
    p_workspace_id: workspaceId,
    p_factory_id: factoryId,
    p_actor_user_id: actorUserId,
    p_experiment_id: request.experimentId,
    p_suite_revision_id: request.suiteRevisionId,
    p_policy_revision_id: request.policyRevisionId,
    p_candidates: request.candidates,
    p_repetitions: request.repetitions,
    p_seed: request.seed,
    p_timeout_ms: request.timeoutMs,
  };
  const freeze = request.evaluation
    ? admin.rpc("freeze_factory_benchmark_experiment_axes_with_evaluation", {
        ...args,
        p_evaluation_plan: request.evaluation,
      })
    : admin.rpc("freeze_factory_benchmark_experiment_axes", args);
  const { data, error } = await freeze.abortSignal(signal);
  if (error?.code === "42501") {
    throw new BenchmarkExperimentError(
      403,
      "Factory manager access is required to freeze a comparison.",
    );
  }
  if (error?.code === "PT409") {
    throw new BenchmarkExperimentError(409, "This comparison already refers to different inputs.");
  }
  if (error?.code === "P0011") {
    throw new BenchmarkExperimentError(409, "This factory no longer accepts new comparisons.");
  }
  if (error?.code === "PT412") {
    throw new BenchmarkExperimentError(
      409,
      "A selected toolchain changed. Refresh the choices and select the exact toolchain again.",
    );
  }
  if (error?.code === "PT422" || error?.code === "22023") {
    throw new BenchmarkExperimentError(
      422,
      "The selected suite, policy, configurations, or scorer revisions are unavailable or incompatible. Refresh the choices and review your selections.",
    );
  }
  if (error) throw error;
  const snapshot = benchmarkAxisSnapshotSchema.parse(data);
  if (
    snapshot.experimentId !== request.experimentId ||
    snapshot.suiteRevisionId !== request.suiteRevisionId ||
    snapshot.policyRevisionId !== request.policyRevisionId ||
    snapshot.candidateCount !== request.candidates.length ||
    snapshot.repetitions !== request.repetitions ||
    snapshot.expectedTrialCount !==
      snapshot.taskCount * snapshot.candidateCount * snapshot.repetitions ||
    snapshot.materializedTrialCount !== snapshot.expectedTrialCount ||
    snapshot.eligibleTrialCount + snapshot.ineligibleTrialCount !==
      snapshot.materializedTrialCount ||
    !matchesBenchmarkEvaluationPlan(snapshot.evaluation, request.evaluation)
  ) {
    throw new Error("The frozen comparison returned an invalid snapshot.");
  }
  return snapshot;
}
