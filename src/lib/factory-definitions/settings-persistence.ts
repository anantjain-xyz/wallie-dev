import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import { executionRequirementsSchema } from "@/lib/execution-policy/contracts";
import type { Database } from "@/lib/supabase/database.types";

import type { CompiledFactoryDefinition } from "./compiler";
import type { FactoryDefinitionCatalog } from "./references";
import { archivedFactoryStageSchema } from "./settings-contracts";
import { factoryStageDefinition, readCompiledFactoryDefinition } from "./stored-definition";

type Client = SupabaseClient<Database>;
const uuid = z.string().uuid();

const metadataSchema = z.object({
  newStageIds: uuid.array().optional(),
  pipelineName: z.string().trim().min(1).max(80).optional(),
  archivedStages: archivedFactoryStageSchema.array().optional(),
  executionPolicy: z.object({ id: uuid, requirements: executionRequirementsSchema }).optional(),
  deliveryPolicy: z.object({ id: uuid, requirements: deliveryRequirementsSchema }).optional(),
});
export type FactorySettingsMetadata = z.infer<typeof metadataSchema>;

export function readFactorySettingsMetadata(value: unknown): FactorySettingsMetadata {
  return metadataSchema.parse(value ?? {});
}

export function archiveRemovedFactoryStages(
  previous: CompiledFactoryDefinition,
  nextStages: readonly { id: string }[],
  archivedStages: NonNullable<FactorySettingsMetadata["archivedStages"]>,
) {
  const activeIds = new Set(nextStages.map(({ id }) => id));
  const archive = new Map(
    archivedStages.filter(({ id }) => !activeIds.has(id)).map((stage) => [stage.id, stage]),
  );
  const archivedAt = new Date().toISOString();
  previous.stages.forEach((stage, index) => {
    if (activeIds.has(stage.id)) return;
    archive.set(stage.id, {
      ...factoryStageDefinition(stage),
      pipelineId: previous.pipelineId,
      position: index + 1,
      archivedAt,
    });
  });
  return [...archive.values()].sort((left, right) =>
    right.archivedAt.localeCompare(left.archivedAt),
  );
}

export function catalogWithSettingsCandidates(
  catalog: FactoryDefinitionCatalog,
  metadata: FactorySettingsMetadata,
  pipelineId: string,
): FactoryDefinitionCatalog {
  const { executionPolicy, deliveryPolicy } = metadata;
  const { executionPolicyRevisions, deliveryPolicyRevisions, workspaceId } = catalog;
  return {
    ...catalog,
    executionPolicyRevisions:
      executionPolicy && !executionPolicyRevisions.some(({ id }) => id === executionPolicy.id)
        ? [...executionPolicyRevisions, { id: executionPolicy.id, workspaceId }]
        : executionPolicyRevisions,
    deliveryPolicyRevisions:
      deliveryPolicy && !deliveryPolicyRevisions.some(({ id }) => id === deliveryPolicy.id)
        ? [...deliveryPolicyRevisions, { id: deliveryPolicy.id, workspaceId, pipelineId }]
        : deliveryPolicyRevisions,
  };
}

export function catalogForStoredFactoryDefinition(
  catalog: FactoryDefinitionCatalog,
  stored: { definition_json: string; settings_metadata?: unknown },
): FactoryDefinitionCatalog {
  const bundle = readCompiledFactoryDefinition(stored.definition_json);
  return bundle
    ? catalogWithSettingsCandidates(
        catalog,
        readFactorySettingsMetadata(stored.settings_metadata),
        bundle.pipelineId,
      )
    : catalog;
}

export function latestFactoryDraft(
  client: Client,
  workspaceId: string,
  factoryId: string,
  activationNumber: number,
) {
  const query = client
    .from("factory_definition_drafts")
    .select("id, canonical_digest, definition_json, settings_metadata, created_at")
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId);
  return (
    activationNumber
      ? query.eq("base_activation_number", activationNumber)
      : query.is("base_activation_number", null)
  )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
}

export async function loadActivatedFactoryArchiveBase(
  client: Client,
  workspaceId: string,
  factoryId: string,
  activationNumber: number,
) {
  const { data, error } = await client
    .from("factory_definition_activations")
    .select(
      "revision:factory_definition_revisions(definition_json,source:factory_definition_drafts(settings_metadata))",
    )
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .eq("activation_number", activationNumber)
    .maybeSingle();
  if (error) throw error;
  return data?.revision ?? null;
}

export async function loadStageAnchors(client: Client, workspaceId: string, pipelineId: string) {
  const rows = [];
  const size = 500;
  for (let from = 0; ; from += size) {
    const { data, error } = await client
      .from("pipeline_stages")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("pipeline_id", pipelineId)
      .order("position")
      .order("id")
      .range(from, from + size - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < size) return rows;
  }
}

export async function saveSettingsFactoryDraft({
  client,
  scope,
  expectedDraftId,
  compiled,
  metadata,
}: {
  client: Client;
  scope: {
    p_workspace_id: string;
    p_factory_id: string;
    p_actor_user_id: string;
    p_expected_activation_number: number;
  };
  expectedDraftId: string | null;
  compiled: { bundle: CompiledFactoryDefinition; definitionJson: string; canonicalDigest: string };
  metadata: FactorySettingsMetadata;
}) {
  const { pipelineId, stages, executionPolicyRevisionId, deliveryPolicyRevisionId } =
    compiled.bundle;
  const anchors = await loadStageAnchors(client, scope.p_workspace_id, pipelineId);
  const anchorIds = new Set(anchors.map(({ id }) => id));
  return client.rpc("save_settings_factory_definition_draft", {
    ...scope,
    ...(expectedDraftId ? { p_expected_draft_id: expectedDraftId } : {}),
    p_definition_json: compiled.definitionJson,
    p_canonical_digest: compiled.canonicalDigest,
    p_settings_metadata: {
      ...metadata,
      newStageIds: stages.filter(({ id }) => !anchorIds.has(id)).map(({ id }) => id),
      executionPolicy:
        metadata.executionPolicy?.id === executionPolicyRevisionId
          ? metadata.executionPolicy
          : undefined,
      deliveryPolicy:
        metadata.deliveryPolicy?.id === deliveryPolicyRevisionId
          ? metadata.deliveryPolicy
          : undefined,
    },
  });
}
