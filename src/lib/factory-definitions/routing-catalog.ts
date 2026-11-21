import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { ModelRoutingConfiguration } from "@/lib/model-routing/contracts";
import type { Database } from "@/lib/supabase/database.types";

import type { QualifiedModelRoutingConfiguration } from "./references";
import { readVerifiedFactoryDefinition } from "./stored-definition";

type Client = Pick<SupabaseClient<Database>, "from">;
type FactoryScope = { workspaceId: string; factoryId: string };

export async function loadQualifiedModelRoutingConfigurations(
  client: Client,
  scope: FactoryScope,
  configurations: readonly ModelRoutingConfiguration[],
): Promise<QualifiedModelRoutingConfiguration[]> {
  if (configurations.length === 0) return [];

  const { workspaceId, factoryId } = scope;
  const revisionIds = [
    ...new Set(configurations.map(({ definitionRevisionId }) => definitionRevisionId)),
  ];
  const definitions = new Map<string, { digest: string; agentId: string }>();
  const revisionBatchSize = 100;
  for (let index = 0; index < revisionIds.length; index += revisionBatchSize) {
    const revisions = await client
      .from("factory_definition_revisions")
      .select("id,canonical_digest,definition_json")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .in("id", revisionIds.slice(index, index + revisionBatchSize));
    if (revisions.error) throw revisions.error;
    for (const { id, canonical_digest, definition_json } of revisions.data) {
      const definition = readVerifiedFactoryDefinition(definition_json, canonical_digest);
      if (definition?.implementationAgent) {
        definitions.set(id, {
          digest: canonical_digest,
          agentId: definition.implementationAgent.agentId,
        });
      }
    }
  }
  const selected = new Map(
    configurations.flatMap((configuration) => {
      const definition = definitions.get(configuration.definitionRevisionId);
      return definition?.agentId === configuration.agentId
        ? [[JSON.stringify(configuration), { configuration, definition }] as const]
        : [];
    }),
  );

  // Use only validated UUIDs and enum values in the raw PostgREST filter.
  const candidateFilters = [
    ...new Set(
      [...selected.values()].map(({ configuration }) => {
        const { experimentId, definitionRevisionId, qualificationId, workerRuntime } =
          configuration;
        return `and(experiment_id.eq.${experimentId},definition_revision_id.eq.${definitionRevisionId},qualification_id.eq.${qualificationId},worker_runtime.eq.${workerRuntime})`;
      }),
    ),
  ];
  const filterBatches: string[] = [];
  const candidateBatchSize = 20;
  for (let index = 0; index < candidateFilters.length; index += candidateBatchSize) {
    filterBatches.push(candidateFilters.slice(index, index + candidateBatchSize).join(","));
  }
  const batches = await Promise.all(
    filterBatches.map(async (filter) => {
      const candidates = await client
        .from("factory_benchmark_experiment_candidates")
        .select(
          "experiment_id,definition_revision_id,definition_digest,qualification_id,canonical_model_key,harness,worker_runtime",
        )
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .or(filter);
      if (candidates.error) throw candidates.error;
      return candidates.data;
    }),
  );
  const candidates = batches.flat();

  const scorerFilters = [
    ...new Set(
      [...selected.values()].flatMap(({ configuration }) => {
        const { experimentId, scorerRevisionId } = configuration;
        return scorerRevisionId
          ? [`and(experiment_id.eq.${experimentId},scorer_revision_id.eq.${scorerRevisionId})`]
          : [];
      }),
    ),
  ];
  const scorerMatches = new Set<string>();
  for (let index = 0; index < scorerFilters.length; index += candidateBatchSize) {
    const dimensions = await client
      .from("factory_benchmark_evaluation_dimensions")
      .select("experiment_id,scorer_revision_id")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", factoryId)
      .or(scorerFilters.slice(index, index + candidateBatchSize).join(","));
    if (dimensions.error) throw dimensions.error;
    for (const { experiment_id, scorer_revision_id } of dimensions.data) {
      scorerMatches.add(`${experiment_id}:${scorer_revision_id}`);
    }
  }

  return [...selected.values()].flatMap(({ configuration, definition }) => {
    if (
      configuration.scorerRevisionId &&
      !scorerMatches.has(`${configuration.experimentId}:${configuration.scorerRevisionId}`)
    ) {
      return [];
    }
    const matches = candidates.filter(
      (candidate) =>
        candidate.experiment_id === configuration.experimentId &&
        candidate.definition_revision_id === configuration.definitionRevisionId &&
        candidate.definition_digest === definition.digest &&
        candidate.qualification_id === configuration.qualificationId &&
        candidate.canonical_model_key === configuration.modelKey &&
        candidate.harness === configuration.harness &&
        candidate.worker_runtime === configuration.workerRuntime,
    );
    return matches.length === 1 ? [{ ...configuration, ...scope }] : [];
  });
}
