import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  resolveAgentConfigValue,
  type AgentConfigMap,
} from "@/features/onboarding/runtime-readiness";
import type { PipelineConfiguration } from "@/features/sessions/types";
import {
  agentProviderSupportsEffort,
  normalizeAgentProviderName,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  type AgentEffort,
} from "@/lib/agent-config/contracts";
import { mapDeliveryPolicy, type DeliveryPolicy } from "@/lib/delivery-policy/contracts";
import { mapExecutionPolicy, type ExecutionPolicy } from "@/lib/execution-policy/contracts";
import {
  factoryActivationRequirements,
  loadFactoryDefinitionCatalog,
} from "@/lib/factory-definitions/authority";
import {
  compileFactoryDefinition,
  type CompiledFactoryDefinition,
  type FactoryDefinitionDiagnostic,
} from "@/lib/factory-definitions/compiler";
import type { FactoryActivationSummary } from "@/lib/factory-definitions/mutations";
import {
  compiledFactoryDefinitionSchema,
  FACTORY_DEFINITION_SCHEMA_VERSION,
  type SerialFactoryDefinitionInput,
} from "@/lib/factory-definitions/schema";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import {
  type SettingsFactoryActivationSummary,
  type SettingsFactoryCommand,
  type SettingsFactoryDefinitionState,
  type SettingsFactoryDraftSummary,
} from "@/lib/factory-definitions/settings-contracts";
import {
  agentConfigFromFactoryDefinition,
  pipelineFromFactoryDefinition,
} from "@/lib/factory-definitions/settings-projection";
import {
  selectDefaultFactory,
  selectStoredFactoryDefinition,
} from "@/lib/factory-definitions/storage";
import { recompileStoredFactoryDefinition } from "@/lib/factory-definitions/stored-definition";
import { loadDefaultPipelineConfigurationForWorkspace } from "@/lib/pipeline/stages";
import { sandboxProviderSchema } from "@/lib/sandbox-connections/contracts";
import type { SandboxProvider } from "@/lib/sandbox/types";
import type { Database, Json } from "@/lib/supabase/database.types";

type ScopedClient = Pick<SupabaseClient<Database>, "from">;
type AdminClient = SupabaseClient<Database>;

export function buildSerialDefinitionFromCompiled(
  compiled: CompiledFactoryDefinition,
): SerialFactoryDefinitionInput {
  return {
    schemaVersion: FACTORY_DEFINITION_SCHEMA_VERSION,
    kind: compiled.kind,
    pipeline: compiled.pipelineId,
    repository: compiled.repositoryId,
    sandboxProvider: compiled.sandboxProvider,
    agent: {
      provider: compiled.agent.provider,
      model: compiled.agent.model,
      effort: compiled.agent.effort,
      concurrencyLimit: compiled.agent.concurrencyLimit,
      stallTimeoutMs: compiled.agent.stallTimeoutMs,
      maxRetries: compiled.agent.maxRetries,
      maxTurns: compiled.agent.maxTurns,
    },
    executionPolicy: compiled.executionPolicyRevisionId,
    deliveryPolicy: compiled.deliveryPolicyRevisionId,
    skills: [...compiled.skillIds],
    tools: [...compiled.toolIds],
    operatingRulesMd: compiled.operatingRulesMd,
    stages: compiled.stages.map((stage) => ({
      id: stage.id,
      slug: stage.slug,
      name: stage.name,
      description: stage.description,
      promptTemplateMd: stage.promptTemplateMd,
      anyoneCanApprove: stage.anyoneCanApprove,
      approverMemberIds: [...stage.approverMemberIds],
    })),
  };
}

export type SettingsFactoryLoadContext = {
  agentConfig?: AgentConfigMap;
  pipelineId?: string | null;
  primaryRepositoryId?: string | null;
  sandboxActiveProvider?: SandboxProvider;
  selectedGithubRepositoryId?: string | null;
  availableRepositoryIds?: readonly string[];
};

function parseCompiledDefinition(definitionJson: string): CompiledFactoryDefinition | null {
  const decoded = parseFactoryDefinitionJson(definitionJson);
  if (!decoded.ok) return null;
  const parsed = compiledFactoryDefinitionSchema.safeParse(decoded.value);
  return parsed.success ? parsed.data : null;
}

async function resolveDefaultRepositoryId(
  client: ScopedClient,
  workspaceId: string,
  context?: SettingsFactoryLoadContext,
): Promise<string | null> {
  if (context?.availableRepositoryIds) {
    const available = new Set(context.availableRepositoryIds);
    for (const candidate of [context.selectedGithubRepositoryId, context.primaryRepositoryId]) {
      if (candidate && available.has(candidate)) return candidate;
    }
    return context.availableRepositoryIds[0] ?? null;
  }

  const [installationResult, repositoriesResult, onboardingResult, primaryProfileResult] =
    await Promise.all([
      client
        .from("github_installations")
        .select("id")
        .eq("workspace_id", workspaceId)
        .eq("suspended", false)
        .maybeSingle(),
      client
        .from("github_repositories")
        .select("id, github_installation_id")
        .eq("workspace_id", workspaceId)
        .eq("is_archived", false)
        .order("full_name", { ascending: true }),
      client
        .from("workspace_onboarding")
        .select("selected_github_repository_id")
        .eq("workspace_id", workspaceId)
        .maybeSingle(),
      client
        .from("workspace_repository_profiles")
        .select("github_repository_id")
        .eq("workspace_id", workspaceId)
        .eq("is_primary", true)
        .maybeSingle(),
    ]);

  if (installationResult.error) throw installationResult.error;
  if (repositoriesResult.error) throw repositoriesResult.error;
  if (onboardingResult.error) throw onboardingResult.error;
  if (primaryProfileResult.error) throw primaryProfileResult.error;

  const activeInstallationId = installationResult.data?.id;
  if (!activeInstallationId) return null;

  const eligibleIds = (repositoriesResult.data ?? [])
    .filter((repo) => repo.github_installation_id === activeInstallationId)
    .map((repo) => repo.id);
  const eligibleSet = new Set(eligibleIds);

  for (const candidate of [
    onboardingResult.data?.selected_github_repository_id,
    primaryProfileResult.data?.github_repository_id,
  ]) {
    if (candidate && eligibleSet.has(candidate)) return candidate;
  }
  return eligibleIds[0] ?? null;
}

export async function loadSettingsFactoryDefinitionState(
  client: ScopedClient,
  workspaceId: string,
  context?: SettingsFactoryLoadContext,
): Promise<SettingsFactoryDefinitionState> {
  const [factoryResult, pipelineResult, executionPolicyPointerResult] = await Promise.all([
    selectDefaultFactory(client, workspaceId),
    context?.pipelineId !== undefined
      ? Promise.resolve({
          data: context.pipelineId ? { id: context.pipelineId } : null,
          error: null,
        })
      : client
          .from("pipelines")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("is_default", true)
          .maybeSingle(),
    client
      .from("execution_policies")
      .select("current_revision_id, revision")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);

  if (factoryResult.error) throw factoryResult.error;
  if (pipelineResult.error) throw pipelineResult.error;
  if (executionPolicyPointerResult.error) throw executionPolicyPointerResult.error;

  const factoryId = factoryResult.data?.id ?? null;
  const defaultPipelineId = pipelineResult.data?.id ?? null;
  const liveExecutionPolicyRevision = executionPolicyPointerResult.data?.revision ?? 0;

  const deliveryPointerPromise = defaultPipelineId
    ? client
        .from("delivery_policies")
        .select("current_revision_id, revision")
        .eq("workspace_id", workspaceId)
        .eq("pipeline_id", defaultPipelineId)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });

  const activationPromise = factoryId
    ? client
        .from("factory_definition_activations")
        .select("id, revision_id, activation_number, previous_activation_number, created_at")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
        .order("activation_number", { ascending: false })
        .limit(1)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });

  const [deliveryPolicyPointerResult, activationResult, defaultRepositoryId] = await Promise.all([
    deliveryPointerPromise,
    activationPromise,
    resolveDefaultRepositoryId(client, workspaceId, context),
  ]);

  if (deliveryPolicyPointerResult.error) throw deliveryPolicyPointerResult.error;
  if (activationResult.error) throw activationResult.error;

  const activationRow = activationResult.data;
  const expectedActivationNumber = activationRow?.activation_number ?? 0;

  const activationRevisionPromise = activationRow
    ? client
        .from("factory_definition_revisions")
        .select("id, definition_json, canonical_digest, created_at")
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId!)
        .eq("id", activationRow.revision_id)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });

  let draftQuery = factoryId
    ? client
        .from("factory_definition_drafts")
        .select(
          "id, base_activation_number, schema_version, definition_json, canonical_digest, created_at",
        )
        .eq("workspace_id", workspaceId)
        .eq("factory_id", factoryId)
    : null;
  if (draftQuery) {
    draftQuery = expectedActivationNumber
      ? draftQuery.eq("base_activation_number", expectedActivationNumber)
      : draftQuery.is("base_activation_number", null);
  }
  const draftPromise = draftQuery
    ? draftQuery
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null });

  const [activationRevisionResult, draftResult] = await Promise.all([
    activationRevisionPromise,
    draftPromise,
  ]);
  if (activationRevisionResult.error) throw activationRevisionResult.error;
  if (draftResult.error) throw draftResult.error;

  let currentActivation: SettingsFactoryActivationSummary | null = null;
  if (activationRow && activationRevisionResult.data) {
    const parsedDef = parseCompiledDefinition(activationRevisionResult.data.definition_json);
    if (parsedDef) {
      currentActivation = {
        id: activationRow.id,
        revisionId: activationRow.revision_id,
        activationNumber: activationRow.activation_number,
        previousActivationNumber: activationRow.previous_activation_number,
        canonicalDigest: activationRevisionResult.data.canonical_digest,
        createdAt: activationRow.created_at,
        definition: parsedDef,
      };
    }
  }

  let latestDraft: SettingsFactoryDraftSummary | null = null;
  if (draftResult.data) {
    const parsedDef = parseCompiledDefinition(draftResult.data.definition_json);
    if (parsedDef) {
      latestDraft = {
        id: draftResult.data.id,
        baseActivationNumber: draftResult.data.base_activation_number,
        schemaVersion: draftResult.data.schema_version,
        canonicalDigest: draftResult.data.canonical_digest,
        createdAt: draftResult.data.created_at,
        definition: parsedDef,
      };
    }
  }

  const activeDefinition = latestDraft?.definition ?? currentActivation?.definition ?? null;

  const resolvedDeliveryPointerPromise =
    activeDefinition && activeDefinition.pipelineId !== defaultPipelineId
      ? client
          .from("delivery_policies")
          .select("current_revision_id, revision")
          .eq("workspace_id", workspaceId)
          .eq("pipeline_id", activeDefinition.pipelineId)
          .maybeSingle()
      : Promise.resolve(deliveryPolicyPointerResult);

  const executionRevisionId = activeDefinition
    ? activeDefinition.executionPolicyRevisionId
    : (executionPolicyPointerResult.data?.current_revision_id ?? null);
  const deliveryRevisionId = activeDefinition
    ? activeDefinition.deliveryPolicyRevisionId
    : (deliveryPolicyPointerResult.data?.current_revision_id ?? null);

  const [resolvedDeliveryPointerResult, executionRevisionResult, deliveryRevisionResult] =
    await Promise.all([
      resolvedDeliveryPointerPromise,
      executionRevisionId
        ? client
            .from("execution_policy_revisions")
            .select("*")
            .eq("workspace_id", workspaceId)
            .eq("id", executionRevisionId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      deliveryRevisionId
        ? client
            .from("delivery_policy_revisions")
            .select("*")
            .eq("workspace_id", workspaceId)
            .eq("id", deliveryRevisionId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

  if (resolvedDeliveryPointerResult.error) throw resolvedDeliveryPointerResult.error;
  if (executionRevisionResult.error) throw executionRevisionResult.error;
  if (deliveryRevisionResult.error) throw deliveryRevisionResult.error;

  const liveDeliveryPolicyRevision = resolvedDeliveryPointerResult.data?.revision ?? 0;

  const executionPolicy: ExecutionPolicy | null = executionRevisionResult.data
    ? mapExecutionPolicy(executionRevisionResult.data)
    : null;
  const deliveryPolicy: DeliveryPolicy | null = deliveryRevisionResult.data
    ? mapDeliveryPolicy(deliveryRevisionResult.data)
    : null;

  return {
    factoryId,
    expectedActivationNumber,
    currentActivation,
    latestDraft,
    activeDefinition,
    defaultRepositoryId: activeDefinition?.repositoryId ?? defaultRepositoryId,
    executionPolicy,
    deliveryPolicy,
    liveExecutionPolicyRevision,
    liveDeliveryPolicyRevision,
  };
}

async function loadBaselineFactoryDefinitionSource(
  admin: AdminClient,
  workspaceId: string,
  state: SettingsFactoryDefinitionState,
): Promise<
  | { ok: true; source: SerialFactoryDefinitionInput; pipelineName: string }
  | { ok: false; error: string }
> {
  const [pipeline, agentConfigResult, sandboxSettingsResult] = await Promise.all([
    loadDefaultPipelineConfigurationForWorkspace(admin, workspaceId),
    admin.from("workspace_agent_config").select("key, value_json").eq("workspace_id", workspaceId),
    admin
      .from("workspace_sandbox_settings")
      .select("active_provider")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);

  if (agentConfigResult.error) throw agentConfigResult.error;
  if (sandboxSettingsResult.error) throw sandboxSettingsResult.error;
  if (!pipeline) {
    return { ok: false, error: "Workspace has no default pipeline." };
  }

  if (state.activeDefinition) {
    return {
      ok: true,
      source: buildSerialDefinitionFromCompiled(state.activeDefinition),
      pipelineName: pipeline.name,
    };
  }

  if (!state.defaultRepositoryId) {
    return {
      ok: false,
      error: "Connect a GitHub repository before saving a factory definition draft.",
    };
  }

  const agentConfig: AgentConfigMap = {};
  for (const row of agentConfigResult.data ?? []) {
    agentConfig[row.key as keyof AgentConfigMap] = row.value_json;
  }

  const provider =
    normalizeAgentProviderName(
      typeof agentConfig.agent_provider === "string" ? agentConfig.agent_provider : undefined,
    ) ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider;
  const rawModel = resolveAgentConfigValue("agent_model", agentConfig);
  const model =
    typeof rawModel === "string" && rawModel.trim()
      ? rawModel
      : RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_model;
  const rawEffort = resolveAgentConfigValue("agent_effort", agentConfig);
  const effort = agentProviderSupportsEffort(provider)
    ? typeof rawEffort === "string" && rawEffort.trim()
      ? (rawEffort as AgentEffort)
      : RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_effort
    : null;

  const sandboxParsed = sandboxProviderSchema.safeParse(
    sandboxSettingsResult.data?.active_provider ?? "vercel",
  );
  const sandboxProvider = sandboxParsed.success ? sandboxParsed.data : "vercel";

  return {
    ok: true,
    pipelineName: pipeline.name,
    source: {
      schemaVersion: FACTORY_DEFINITION_SCHEMA_VERSION,
      kind: "serial",
      pipeline: pipeline.id,
      repository: state.defaultRepositoryId,
      sandboxProvider,
      agent: {
        provider,
        model,
        effort,
        concurrencyLimit: Number(resolveAgentConfigValue("concurrency_limit", agentConfig)),
        stallTimeoutMs: Number(resolveAgentConfigValue("stall_timeout_ms", agentConfig)),
        maxRetries: Number(resolveAgentConfigValue("max_retries", agentConfig)),
        maxTurns: Number(resolveAgentConfigValue("max_turns", agentConfig)),
      },
      executionPolicy: state.executionPolicy?.id ?? null,
      deliveryPolicy: state.deliveryPolicy?.id ?? null,
      skills: [],
      tools: [],
      operatingRulesMd: pipeline.operatingRulesMd ?? "",
      stages: pipeline.stages.map((stage) => ({
        id: stage.id,
        slug: stage.slug,
        name: stage.name,
        description: stage.description,
        promptTemplateMd: stage.promptTemplateMd,
        anyoneCanApprove: stage.anyoneCanApprove,
        approverMemberIds: [...stage.approverMemberIds],
      })),
    },
  };
}

export async function loadFactoryDefinitionHistoryForStages(
  client: ScopedClient,
  workspaceId: string,
  state: Pick<
    SettingsFactoryDefinitionState,
    "factoryId" | "currentActivation" | "latestDraft" | "activeDefinition"
  >,
  extraDefinitions: readonly (CompiledFactoryDefinition | null | undefined)[] = [],
): Promise<CompiledFactoryDefinition[]> {
  const definitions: CompiledFactoryDefinition[] = [];
  for (const candidate of [
    state.activeDefinition,
    state.latestDraft?.definition,
    state.currentActivation?.definition,
    ...extraDefinitions,
  ]) {
    if (candidate) definitions.push(candidate);
  }
  if (!state.factoryId) return definitions;

  const [draftsResult, revisionsResult] = await Promise.all([
    client
      .from("factory_definition_drafts")
      .select("id, created_at, definition_json")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", state.factoryId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
    client
      .from("factory_definition_revisions")
      .select("id, created_at, definition_json")
      .eq("workspace_id", workspaceId)
      .eq("factory_id", state.factoryId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
  ]);
  if (draftsResult.error) throw draftsResult.error;
  if (revisionsResult.error) throw revisionsResult.error;

  const combined = [...(draftsResult.data ?? []), ...(revisionsResult.data ?? [])].sort((a, b) => {
    const timeDiff = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (Number.isFinite(timeDiff) && timeDiff !== 0) return timeDiff;
    return b.id.localeCompare(a.id);
  });

  for (const row of combined) {
    const parsed = parseCompiledDefinition(row.definition_json);
    if (parsed) definitions.push(parsed);
  }
  return definitions;
}

function mapDraftRpcError(error: { code?: string; message?: string } | null): {
  ok: false;
  status: 400 | 403 | 404 | 409 | 422 | 500;
  error: string;
} {
  switch (error?.code) {
    case "PT409":
      return {
        ok: false,
        status: 409,
        error: error.message ?? "Another configuration draft was saved. Reload before retrying.",
      };
    case "PT422":
      return {
        ok: false,
        status: 422,
        error: error.message ?? "Review the factory definition before retrying.",
      };
    case "42501":
      return { ok: false, status: 403, error: "Active workspace manager access is required." };
    case "P0002":
      return {
        ok: false,
        status: 404,
        error: "The requested factory definition record is unavailable.",
      };
    case "22023":
    case "23514":
      return {
        ok: false,
        status: 400,
        error: error.message ?? "The factory definition draft command is invalid.",
      };
    default:
      return { ok: false, status: 500, error: "Could not save the factory definition draft." };
  }
}

export type SettingsFactoryMutationResult =
  | {
      ok: true;
      result: {
        state: SettingsFactoryDefinitionState;
        activation?: FactoryActivationSummary;
        pipeline?: PipelineConfiguration;
        agentConfig?: AgentConfigMap;
        executionPolicy?: ExecutionPolicy | null;
        deliveryPolicy?: DeliveryPolicy | null;
        sandboxProvider?: SandboxProvider;
      };
    }
  | {
      ok: false;
      status: 400 | 403 | 404 | 409 | 422 | 500;
      error: string;
      diagnostics?: FactoryDefinitionDiagnostic[];
    };

export async function mutateSettingsFactoryDefinition({
  admin,
  workspaceId,
  actorUserId,
  command,
}: {
  admin: AdminClient;
  workspaceId: string;
  actorUserId: string;
  command: SettingsFactoryCommand;
}): Promise<SettingsFactoryMutationResult> {
  const currentState = await loadSettingsFactoryDefinitionState(admin, workspaceId);
  if (!currentState.factoryId) {
    return { ok: false, status: 404, error: "Default factory not found." };
  }

  if (command.expectedActivationNumber !== currentState.expectedActivationNumber) {
    return {
      ok: false,
      status: 409,
      error: "The active factory definition changed. Reload before retrying.",
    };
  }

  if (command.action === "publish") {
    const currentDraftId = currentState.latestDraft?.id ?? null;
    if (!currentDraftId || command.draftId !== currentDraftId) {
      return {
        ok: false,
        status: 409,
        error: "A newer configuration draft or activation exists. Reload before publishing.",
      };
    }

    const { data: stored, error: readError } = await selectStoredFactoryDefinition(
      admin,
      workspaceId,
      currentState.factoryId,
      { kind: "draft", id: command.draftId },
    );
    if (readError) {
      return mapDraftRpcError(readError);
    }
    if (!stored) {
      return {
        ok: false,
        status: 404,
        error: "The requested factory definition record is unavailable.",
      };
    }

    const catalog = await loadFactoryDefinitionCatalog(admin, workspaceId);
    const compiled = recompileStoredFactoryDefinition(
      stored.definition_json,
      stored.canonical_digest,
      catalog,
    );
    if (!compiled.ok) {
      return {
        ok: false,
        status: 422,
        error: "Review the factory definition before retrying.",
        diagnostics: compiled.diagnostics,
      };
    }

    const { enabledSandboxProviders, requiredProbes } = factoryActivationRequirements(
      compiled.bundle,
    );
    const { data: activationRow, error: publishError } = await admin.rpc(
      "publish_settings_factory_definition_draft",
      {
        p_workspace_id: workspaceId,
        p_factory_id: currentState.factoryId,
        p_actor_user_id: actorUserId,
        p_expected_activation_number: command.expectedActivationNumber,
        p_draft_id: command.draftId,
        p_enabled_sandbox_providers: enabledSandboxProviders,
        p_required_probes: requiredProbes,
      },
    );
    if (publishError || !activationRow) {
      return mapDraftRpcError(publishError);
    }

    const activation: FactoryActivationSummary = {
      id: activationRow.id,
      revisionId: activationRow.revision_id,
      activationNumber: activationRow.activation_number,
      previousActivationNumber: activationRow.previous_activation_number,
      createdAt: activationRow.created_at,
    };

    const [nextState, livePipeline] = await Promise.all([
      loadSettingsFactoryDefinitionState(admin, workspaceId),
      loadDefaultPipelineConfigurationForWorkspace(admin, workspaceId),
    ]);
    const priorDefinitions = await loadFactoryDefinitionHistoryForStages(
      admin,
      workspaceId,
      nextState,
      [currentState.activeDefinition, currentState.currentActivation?.definition],
    );
    const pipeline =
      nextState.activeDefinition && livePipeline
        ? pipelineFromFactoryDefinition(livePipeline, nextState.activeDefinition, priorDefinitions)
        : (livePipeline ?? undefined);

    return {
      ok: true,
      result: {
        state: nextState,
        activation,
        ...(pipeline ? { pipeline } : {}),
        ...(nextState.activeDefinition
          ? {
              agentConfig: agentConfigFromFactoryDefinition(nextState.activeDefinition),
              sandboxProvider: nextState.activeDefinition.sandboxProvider,
            }
          : {}),
        executionPolicy: nextState.executionPolicy,
        deliveryPolicy: nextState.deliveryPolicy,
      },
    };
  }

  const currentDraftId = currentState.latestDraft?.id ?? null;
  if (command.expectedDraftId !== currentDraftId) {
    return {
      ok: false,
      status: 409,
      error: "Another configuration draft was saved. Reload before retrying.",
    };
  }

  const baseline = await loadBaselineFactoryDefinitionSource(admin, workspaceId, currentState);
  if (!baseline.ok) {
    return { ok: false, status: 422, error: baseline.error };
  }

  const candidate: SerialFactoryDefinitionInput = {
    ...baseline.source,
    agent: { ...baseline.source.agent },
    skills: [...(baseline.source.skills ?? [])],
    tools: [...(baseline.source.tools ?? [])],
    stages: baseline.source.stages.map((stage) => ({
      ...stage,
      approverMemberIds: [...(stage.approverMemberIds ?? [])],
    })),
  };

  const catalog = await loadFactoryDefinitionCatalog(admin, workspaceId);
  const effectiveCatalog = {
    ...catalog,
    executionPolicyRevisions: [...catalog.executionPolicyRevisions],
    deliveryPolicyRevisions: [...catalog.deliveryPolicyRevisions],
  };

  let nextPipelineName = baseline.pipelineName;
  let pendingPipelineRename: { id: string; name: string } | null = null;
  let pendingNewStages: Array<{
    id: string;
    slug: string;
    name: string;
    description: string;
    promptTemplateMd: string;
    anyoneCanApprove: boolean;
  }> = [];
  let pendingExecutionPolicy: {
    revisionId: string;
    requirements: Json;
    expectedLiveRevision: number;
  } | null = null;
  let pendingDeliveryPolicy: {
    revisionId: string;
    pipelineId: string;
    requirements: Json;
    expectedLiveRevision: number;
  } | null = null;

  const { patch } = command;

  switch (patch.kind) {
    case "pipeline": {
      const pipelineId = candidate.pipeline;
      const { data: existingRows, error: stagesError } = await admin
        .from("pipeline_stages")
        .select("id, slug, position")
        .eq("workspace_id", workspaceId)
        .eq("pipeline_id", pipelineId);
      if (stagesError) throw stagesError;

      const rows = existingRows ?? [];
      const priorDefinitionsForSlugs = await loadFactoryDefinitionHistoryForStages(
        admin,
        workspaceId,
        currentState,
      );
      const effectiveSlugByStageId = new Map<string, string>();
      for (const row of rows) {
        effectiveSlugByStageId.set(row.id, row.slug);
      }
      const seenSlugInDefinitions = new Set<string>();
      for (const prior of priorDefinitionsForSlugs) {
        for (const priorStage of prior.stages) {
          if (!seenSlugInDefinitions.has(priorStage.id)) {
            seenSlugInDefinitions.add(priorStage.id);
            effectiveSlugByStageId.set(priorStage.id, priorStage.slug);
          }
        }
      }

      const submittedById = new Map(
        patch.stages
          .filter((stage): stage is typeof stage & { id: string } => Boolean(stage.id))
          .map((stage) => [stage.id, stage]),
      );

      for (const stage of patch.stages) {
        const conflict = rows.find((row) => {
          const effectiveSlug = effectiveSlugByStageId.get(row.id) ?? row.slug;
          if (effectiveSlug !== stage.slug || row.id === (stage.id ?? null)) return false;
          const submittedOwner = submittedById.get(row.id);
          return !(submittedOwner && submittedOwner.slug !== effectiveSlug);
        });
        if (conflict) {
          return {
            ok: false,
            status: 422,
            error: `The slug “${stage.slug}” belongs to an archived stage. Restore that stage instead.`,
          };
        }
      }

      const existingSlugs = new Set(rows.map((row) => row.slug));
      const resolvedStages: SerialFactoryDefinitionInput["stages"] = [];
      const allocatedStages: typeof pendingNewStages = [];

      for (const stage of patch.stages) {
        let stageId = stage.id ?? null;
        if (!stageId) {
          stageId = randomUUID();
          const anchorSlug = existingSlugs.has(stage.slug)
            ? `${stage.slug.slice(0, 50)}-${randomUUID().slice(0, 8)}`
            : stage.slug;
          existingSlugs.add(anchorSlug);
          allocatedStages.push({
            id: stageId,
            slug: anchorSlug,
            name: stage.name,
            description: stage.description ?? "",
            promptTemplateMd: stage.promptTemplateMd ?? "",
            anyoneCanApprove: stage.anyoneCanApprove ?? false,
          });
        }
        resolvedStages.push({
          id: stageId,
          slug: stage.slug,
          name: stage.name,
          description: stage.description ?? "",
          promptTemplateMd: stage.promptTemplateMd ?? "",
          anyoneCanApprove: stage.anyoneCanApprove ?? false,
          approverMemberIds: [...(stage.approverMemberIds ?? [])],
        });
      }

      if (patch.name !== baseline.pipelineName) {
        pendingPipelineRename = { id: pipelineId, name: patch.name };
        nextPipelineName = patch.name;
      }

      pendingNewStages = allocatedStages;
      candidate.operatingRulesMd = patch.operatingRulesMd;
      candidate.stages = resolvedStages;
      break;
    }

    case "agent": {
      candidate.agent = {
        provider: patch.agent.provider,
        model: patch.agent.model,
        effort: agentProviderSupportsEffort(patch.agent.provider) ? patch.agent.effort : null,
        concurrencyLimit: patch.agent.concurrencyLimit,
        stallTimeoutMs: patch.agent.stallTimeoutMs,
        maxRetries: patch.agent.maxRetries,
        maxTurns: patch.agent.maxTurns,
      };
      break;
    }

    case "execution-policy": {
      if (patch.expectedPolicyRevision !== currentState.liveExecutionPolicyRevision) {
        return {
          ok: false,
          status: 409,
          error: "The execution policy changed. Reload before retrying.",
        };
      }
      const candidateRevisionId = randomUUID();
      effectiveCatalog.executionPolicyRevisions.push({
        id: candidateRevisionId,
        workspaceId,
      });
      candidate.executionPolicy = candidateRevisionId;
      pendingExecutionPolicy = {
        revisionId: candidateRevisionId,
        requirements: patch.requirements as Json,
        expectedLiveRevision: patch.expectedPolicyRevision,
      };
      break;
    }

    case "delivery-policy": {
      if (patch.pipelineId !== candidate.pipeline) {
        return {
          ok: false,
          status: 422,
          error: "Choose a delivery policy revision for the active pipeline.",
        };
      }
      if (patch.expectedPolicyRevision !== currentState.liveDeliveryPolicyRevision) {
        return {
          ok: false,
          status: 409,
          error: "The delivery policy changed. Reload before retrying.",
        };
      }
      const candidateRevisionId = randomUUID();
      effectiveCatalog.deliveryPolicyRevisions.push({
        id: candidateRevisionId,
        workspaceId,
        pipelineId: patch.pipelineId,
      });
      candidate.deliveryPolicy = candidateRevisionId;
      pendingDeliveryPolicy = {
        revisionId: candidateRevisionId,
        pipelineId: patch.pipelineId,
        requirements: patch.requirements as Json,
        expectedLiveRevision: patch.expectedPolicyRevision,
      };
      break;
    }

    case "sandbox-provider": {
      candidate.sandboxProvider = patch.sandboxProvider;
      break;
    }
  }

  const compiled = compileFactoryDefinition(
    { kind: "structured", value: candidate },
    effectiveCatalog,
  );
  if (!compiled.ok) {
    return {
      ok: false,
      status: 422,
      error: compiled.diagnostics[0]?.message ?? "Review the factory definition before retrying.",
      diagnostics: compiled.diagnostics,
    };
  }

  const { data: savedDraftRow, error: saveError } = await admin.rpc(
    "save_settings_factory_definition_draft",
    {
      p_workspace_id: workspaceId,
      p_factory_id: currentState.factoryId,
      p_actor_user_id: actorUserId,
      p_expected_activation_number: command.expectedActivationNumber,
      p_definition_json: compiled.definitionJson,
      p_canonical_digest: compiled.canonicalDigest,
      ...(command.expectedDraftId ? { p_expected_draft_id: command.expectedDraftId } : {}),
      ...(pendingExecutionPolicy
        ? {
            p_execution_policy_revision_id: pendingExecutionPolicy.revisionId,
            p_execution_policy_requirements: pendingExecutionPolicy.requirements,
            p_expected_live_execution_policy_revision: pendingExecutionPolicy.expectedLiveRevision,
          }
        : {}),
      ...(pendingDeliveryPolicy
        ? {
            p_delivery_policy_revision_id: pendingDeliveryPolicy.revisionId,
            p_delivery_policy_pipeline_id: pendingDeliveryPolicy.pipelineId,
            p_delivery_policy_requirements: pendingDeliveryPolicy.requirements,
            p_expected_live_delivery_policy_revision: pendingDeliveryPolicy.expectedLiveRevision,
          }
        : {}),
      ...(pendingPipelineRename
        ? {
            p_pipeline_rename_id: pendingPipelineRename.id,
            p_pipeline_rename_name: pendingPipelineRename.name,
          }
        : {}),
      ...(pendingNewStages.length > 0 ? { p_new_pipeline_stages: pendingNewStages as Json } : {}),
    },
  );

  if (saveError || !savedDraftRow) {
    return mapDraftRpcError(saveError);
  }

  const [nextState, livePipeline] = await Promise.all([
    loadSettingsFactoryDefinitionState(admin, workspaceId),
    loadDefaultPipelineConfigurationForWorkspace(admin, workspaceId),
  ]);
  const priorDefinitions = await loadFactoryDefinitionHistoryForStages(
    admin,
    workspaceId,
    nextState,
    [currentState.activeDefinition, currentState.currentActivation?.definition],
  );
  const pipeline =
    nextState.activeDefinition && livePipeline
      ? pipelineFromFactoryDefinition(
          { ...livePipeline, name: nextPipelineName },
          nextState.activeDefinition,
          priorDefinitions,
        )
      : (livePipeline ?? undefined);

  return {
    ok: true,
    result: {
      state: nextState,
      ...(pipeline ? { pipeline } : {}),
      ...(nextState.activeDefinition
        ? {
            agentConfig: agentConfigFromFactoryDefinition(nextState.activeDefinition),
            sandboxProvider: nextState.activeDefinition.sandboxProvider,
          }
        : {}),
      executionPolicy: nextState.executionPolicy,
      deliveryPolicy: nextState.deliveryPolicy,
    },
  };
}
