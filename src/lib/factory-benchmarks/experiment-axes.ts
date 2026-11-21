import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { readVerifiedFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import type { Database } from "@/lib/supabase/database.types";

import {
  benchmarkAxisCatalogSchema,
  benchmarkAxisSnapshotSchema,
  type BenchmarkAxisCatalog,
  type BenchmarkAxisRequest,
} from "./experiment-axes-contracts";
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

export async function loadBenchmarkExperimentAxes({
  supabase,
  workspaceId,
  factoryId,
  suiteRevisionId,
}: {
  supabase: Client;
  workspaceId: string;
  factoryId: string;
  suiteRevisionId: string;
}): Promise<BenchmarkAxisCatalog> {
  const [revisions, policies, receipts] = await Promise.all([
    readPages((from, to) =>
      supabase
        .from("factory_definition_revisions")
        .select("id,canonical_digest,definition_json")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to),
    ),
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
  ]);

  const definitions = revisions.flatMap((revision) => {
    const definition = readVerifiedFactoryDefinition(
      revision.definition_json,
      revision.canonical_digest,
    );
    return definition
      ? [
          {
            id: revision.id,
            digest: revision.canonical_digest,
            label: `${definition.agent.model} · ${revision.canonical_digest.slice(0, 8)}`,
            sandboxProvider: definition.sandboxProvider,
          },
        ]
      : [];
  });
  const definitionIds = new Set(definitions.map(({ id }) => id));
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
  for (const receipt of receipts) {
    if (!definitionIds.has(receipt.definition_id)) continue;
    const key = `${receipt.id}:${receipt.unavailable_reason ?? ""}`;
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
  const { data, error } = await admin
    .rpc("freeze_factory_benchmark_experiment_axes", {
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
    })
    .abortSignal(signal);
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
  if (error?.code === "PT422" || error?.code === "22023") {
    throw new BenchmarkExperimentError(
      422,
      "A candidate is unavailable or the selected axes cannot form a comparison. Check the suite, policy, and capability checks.",
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
    snapshot.eligibleTrialCount + snapshot.ineligibleTrialCount !== snapshot.materializedTrialCount
  ) {
    throw new Error("The frozen comparison returned an invalid snapshot.");
  }
  return snapshot;
}
