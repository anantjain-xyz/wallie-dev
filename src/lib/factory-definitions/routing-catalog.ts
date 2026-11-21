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
    configurations.map((configuration) => [JSON.stringify(configuration), configuration]),
  );
  const unique = [...selected.values()];
  const qualified: QualifiedModelRoutingConfiguration[] = [];
  const batchSize = 8;
  for (let index = 0; index < unique.length; index += batchSize) {
    const batch = await Promise.all(
      unique.slice(index, index + batchSize).map(async (configuration) => {
        const definition = definitions.get(configuration.definitionRevisionId);
        if (definition?.agentId !== configuration.agentId) return null;
        const candidate = await client
          .from("factory_benchmark_experiment_candidates")
          .select("candidate_key")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("experiment_id", configuration.experimentId)
          .eq("definition_revision_id", configuration.definitionRevisionId)
          .eq("definition_digest", definition.digest)
          .eq("qualification_id", configuration.qualificationId)
          .eq("canonical_model_key", configuration.modelKey)
          .eq("harness", configuration.harness)
          .eq("worker_runtime", configuration.workerRuntime)
          .limit(2);
        if (candidate.error) throw candidate.error;
        return candidate.data.length === 1 ? { ...configuration, ...scope } : null;
      }),
    );
    for (const configuration of batch) if (configuration) qualified.push(configuration);
  }
  return qualified;
}
