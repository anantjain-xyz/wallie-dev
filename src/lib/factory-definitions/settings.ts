import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { deliveryRequirementsSchema } from "@/lib/delivery-policy/contracts";
import { executionRequirementsSchema } from "@/lib/execution-policy/contracts";
import { mapStageRow } from "@/lib/pipeline/stages";
import type { Database } from "@/lib/supabase/database.types";

import { factoryActivationRequirements, loadFactoryDefinitionCatalog } from "./authority";
import { compileFactoryDefinition, type CompiledFactoryDefinition } from "./compiler";
import {
  invalidDefinition,
  mutationError,
  type FactoryDefinitionMutationFailure,
} from "./mutations";
import { normalizeFactoryId } from "./references";
import { loadSettingsBaseline } from "./settings-baseline";
import type {
  FactorySettingsCommand,
  FactorySettingsPatch,
  FactorySettingsSnapshot,
} from "./settings-contracts";
import {
  archiveRemovedFactoryStages,
  catalogWithSettingsCandidates,
  latestFactoryDraft,
  loadStageAnchors,
  readFactorySettingsMetadata,
  saveSettingsFactoryDraft,
} from "./settings-persistence";
import { selectCurrentFactoryActivation, selectDefaultFactory } from "./storage";
import {
  factoryDefinitionFromBundle,
  factoryStageDefinition,
  readCompiledFactoryDefinition,
  recompileStoredFactoryDefinition,
} from "./stored-definition";

type Client = SupabaseClient<Database>;
type Identity = NonNullable<FactorySettingsSnapshot["published"]>;
type DefinitionRecord = Identity & { definitionJson: string; bundle: CompiledFactoryDefinition };
type ArchivedStage = FactorySettingsSnapshot["pipeline"]["archivedStages"][number];

function readRecord(row: {
  id: string;
  definition_json: string;
  canonical_digest: string;
}): DefinitionRecord {
  const bundle = readCompiledFactoryDefinition(row.definition_json);
  if (!bundle) throw new Error("Stored factory definition is invalid.");
  return { id: row.id, digest: row.canonical_digest, definitionJson: row.definition_json, bundle };
}

async function loadSettingsContext(client: Client, workspaceId: string, includeDraft: boolean) {
  const factory = await selectDefaultFactory(client, workspaceId);
  if (factory.error) throw factory.error;
  if (!factory.data) return null;
  const factoryId = factory.data.id;
  const activation = await selectCurrentFactoryActivation(client, workspaceId, factoryId);
  if (activation.error) throw activation.error;
  const activationNumber = activation.data?.activation_number ?? 0;

  const [activeRow, draftRow] = await Promise.all([
    activation.data &&
      client
        .from("factory_definition_revisions")
        .select("id, definition_json, canonical_digest, source_draft_id")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .eq("id", activation.data.revision_id)
        .single(),
    includeDraft && latestFactoryDraft(client, workspaceId, factoryId, activationNumber),
  ]);
  if (activeRow && activeRow.error) throw activeRow.error;
  if (draftRow && draftRow.error) throw draftRow.error;
  const draft = draftRow && draftRow.data ? readRecord(draftRow.data) : null;
  const published = activeRow && activeRow.data ? readRecord(activeRow.data) : null;
  if (!includeDraft && !published) return null;

  const source = draft ?? published;
  const sourceDraftId = activeRow && activeRow.data ? activeRow.data.source_draft_id : null;
  const pipelineQuery = client
    .from("pipelines")
    .select("id, name, is_default, operating_rules_md")
    .eq("workspace_id", workspaceId);
  const [pipelineRow, publishedMetadata] = await Promise.all([
    (source
      ? pipelineQuery.eq("id", source.bundle.pipelineId)
      : pipelineQuery.eq("is_default", true)
    ).maybeSingle(),
    includeDraft && sourceDraftId && !draft
      ? client
          .from("factory_definition_drafts")
          .select("settings_metadata")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .eq("id", sourceDraftId)
          .maybeSingle()
      : null,
  ]);
  if (pipelineRow.error) throw pipelineRow.error;
  if (publishedMetadata?.error) throw publishedMetadata.error;
  if (!pipelineRow.data) return null;

  const pipeline = pipelineRow.data;
  const stageRows = includeDraft ? await loadStageAnchors(client, workspaceId, pipeline.id) : [];
  const bundle =
    source?.bundle ??
    (await loadSettingsBaseline(
      client,
      workspaceId,
      pipeline.id,
      stageRows,
      pipeline.operating_rules_md,
      factoryId,
    ));
  if (!bundle) return null;

  const privateMetadata =
    draftRow && draftRow.data
      ? draftRow.data.settings_metadata
      : publishedMetadata?.data?.settings_metadata;
  const metadata = readFactorySettingsMetadata(privateMetadata);
  const archived = new Map<string, ArchivedStage>();
  for (const row of stageRows) {
    if (row.archived_at && row.slug !== "factory-stage-" + row.id) {
      archived.set(row.id, { ...mapStageRow(row), archivedAt: row.archived_at });
    }
  }
  for (const stage of metadata.archivedStages ?? []) archived.set(stage.id, stage);
  const activeStageIds = new Set(bundle.stages.map(({ id }) => id));

  return {
    factoryId,
    activationNumber,
    draft,
    published,
    bundle,
    metadata,
    pipeline: {
      id: pipeline.id,
      isDefault: pipeline.is_default,
      name: (draft && metadata.pipelineName) || pipeline.name,
      archivedStages: [...archived.values()]
        .filter(({ id }) => !activeStageIds.has(id))
        .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt)),
    },
  };
}

type SettingsContext = NonNullable<Awaited<ReturnType<typeof loadSettingsContext>>>;

async function projectSettings(
  client: Client,
  workspaceId: string,
  context: SettingsContext,
): Promise<FactorySettingsSnapshot> {
  const { activationNumber, published, draft, bundle, pipeline, metadata } = context;
  const executionStaged =
    metadata.executionPolicy?.id === bundle.executionPolicyRevisionId
      ? metadata.executionPolicy
      : null;
  const deliveryStaged =
    metadata.deliveryPolicy?.id === bundle.deliveryPolicyRevisionId
      ? metadata.deliveryPolicy
      : null;
  const [execution, delivery] = await Promise.all([
    !executionStaged && bundle.executionPolicyRevisionId
      ? client
          .from("execution_policy_revisions")
          .select("requirements")
          .eq("workspace_id", workspaceId)
          .eq("id", bundle.executionPolicyRevisionId)
          .single()
      : null,
    !deliveryStaged && bundle.deliveryPolicyRevisionId
      ? client
          .from("delivery_policy_revisions")
          .select("requirements")
          .eq("workspace_id", workspaceId)
          .eq("pipeline_id", pipeline.id)
          .eq("id", bundle.deliveryPolicyRevisionId)
          .single()
      : null,
  ]);
  if (execution?.error) throw execution.error;
  if (delivery?.error) throw delivery.error;
  return {
    activationNumber,
    published: published && { id: published.id, digest: published.digest },
    draft: draft && { id: draft.id, digest: draft.digest },
    publishedStages:
      published?.bundle.stages.map(({ id, name, slug }) => ({ id, name, slug })) ?? [],
    repositoryId: bundle.repositoryId,
    pipeline: {
      ...pipeline,
      operatingRulesMd: bundle.operatingRulesMd,
      stages: bundle.stages.map((stage, index) => ({
        ...factoryStageDefinition(stage),
        pipelineId: pipeline.id,
        position: index + 1,
      })),
    },
    agent: bundle.agent,
    sandboxProvider: bundle.sandboxProvider,
    executionPolicy:
      executionStaged?.requirements ??
      (execution ? executionRequirementsSchema.parse(execution.data.requirements) : null),
    deliveryPolicy:
      deliveryStaged?.requirements ??
      (delivery ? deliveryRequirementsSchema.parse(delivery.data.requirements) : null),
  };
}

export async function loadFactorySettings(
  client: Client,
  workspaceId: string,
  includeDraft: boolean,
) {
  const context = await loadSettingsContext(client, workspaceId, includeDraft);
  return context ? projectSettings(client, workspaceId, context) : null;
}

function applySettingsPatch(context: SettingsContext, patch: FactorySettingsPatch) {
  const source = factoryDefinitionFromBundle(context.bundle);
  // The published metadata can describe historical staging, but its policy rows
  // are now immutable public revisions. Only an unpublished draft can carry them.
  const metadata = context.draft ? { ...context.metadata } : {};
  const pipeline = { ...context.pipeline };
  switch (patch.kind) {
    case "pipeline": {
      const availableIds = new Set(
        [...source.stages, ...pipeline.archivedStages].map(({ id }) => id),
      );
      if (patch.stages.some(({ id }) => id && !availableIds.has(normalizeFactoryId(id))))
        return null;
      source.stages = patch.stages.map((stage) => ({
        ...stage,
        id: stage.id ? normalizeFactoryId(stage.id) : randomUUID(),
      }));
      source.operatingRulesMd = patch.operatingRulesMd;
      pipeline.name = patch.name;
      pipeline.archivedStages = archiveRemovedFactoryStages(
        context.bundle,
        source.stages,
        pipeline.archivedStages,
      );
      break;
    }
    case "agent":
      source.agent = patch.agent;
      break;
    case "sandbox-provider":
      source.sandboxProvider = patch.provider;
      break;
    case "execution-policy":
      metadata.executionPolicy = { id: randomUUID(), requirements: patch.requirements };
      source.executionPolicy = metadata.executionPolicy.id;
      break;
    case "delivery-policy":
      metadata.deliveryPolicy = { id: randomUUID(), requirements: patch.requirements };
      source.deliveryPolicy = metadata.deliveryPolicy.id;
      break;
  }
  metadata.pipelineName = pipeline.name;
  metadata.archivedStages = pipeline.archivedStages;
  return { source, pipeline, metadata };
}

export async function mutateFactorySettings({
  client,
  workspaceId,
  actorUserId,
  command,
}: {
  client: Client;
  workspaceId: string;
  actorUserId: string;
  command: FactorySettingsCommand;
}): Promise<FactoryDefinitionMutationFailure | { ok: true; snapshot: FactorySettingsSnapshot }> {
  const context = await loadSettingsContext(client, workspaceId, true);
  if (!context) return mutationError({ code: "P0002" });
  const draftId = command.action === "save" ? command.expectedDraftId : command.draftId;
  if (
    command.expectedActivationNumber !== context.activationNumber ||
    draftId !== (context.draft?.id ?? null)
  ) {
    return mutationError({
      code: "PT409",
      message: "The factory configuration changed. Reload before retrying.",
    });
  }

  const scope = {
    p_workspace_id: workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: actorUserId,
    p_expected_activation_number: command.expectedActivationNumber,
  };
  const catalog = await loadFactoryDefinitionCatalog(client, {
    workspaceId,
    factoryId: context.factoryId,
    agentPromptRevisionId: context.bundle.implementationAgent?.promptRevisionId,
    skillRevisionIds: context.bundle.skillIds,
  });
  if (command.action === "save") {
    const edited = applySettingsPatch(context, command.patch);
    if (!edited) {
      return invalidDefinition([
        {
          path: ["stages"],
          code: "missing_reference",
          message: "Choose stages from this pipeline.",
        },
      ]);
    }
    const { source, pipeline, metadata } = edited;
    const compiled = compileFactoryDefinition(
      { kind: "structured", value: source },
      catalogWithSettingsCandidates(catalog, metadata, pipeline.id),
    );
    if (!compiled.ok) return invalidDefinition(compiled.diagnostics);
    const snapshot = await projectSettings(client, workspaceId, {
      ...context,
      bundle: compiled.bundle,
      pipeline,
      metadata,
    });
    const { data, error } = await saveSettingsFactoryDraft({
      client,
      scope,
      expectedDraftId: draftId,
      compiled,
      metadata,
    });
    if (error || !data) return mutationError(error);

    return {
      ok: true,
      snapshot: { ...snapshot, draft: { id: data.id, digest: data.canonical_digest } },
    };
  }

  const draft = context.draft;
  if (!draft) return mutationError({ code: "P0002" });
  const compiled = recompileStoredFactoryDefinition(
    draft.definitionJson,
    draft.digest,
    catalogWithSettingsCandidates(catalog, context.metadata, context.pipeline.id),
  );
  if (!compiled.ok) return invalidDefinition(compiled.diagnostics);

  const snapshot = await projectSettings(client, workspaceId, {
    ...context,
    draft: null,
    published: draft,
  });
  const requirements = factoryActivationRequirements(compiled.bundle);
  const { data, error } = await client.rpc("publish_settings_factory_definition_draft", {
    ...scope,
    p_draft_id: draft.id,
    p_enabled_sandbox_providers: requirements.enabledSandboxProviders,
    p_required_probes: requirements.requiredProbes,
  });
  if (error || !data) return mutationError(error);

  return {
    ok: true,
    snapshot: {
      ...snapshot,
      activationNumber: data.activation_number,
      published: { id: data.revision_id, digest: draft.digest },
    },
  };
}
