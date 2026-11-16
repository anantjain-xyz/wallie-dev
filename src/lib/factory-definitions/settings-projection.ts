import type { AgentConfigFieldErrors } from "@/app/api/agent-config/route";
import type { PipelineConfiguration, PipelineStage } from "@/features/sessions/types";
import type { SettingsPageData, SettingsSetupData } from "@/features/settings/data";
import { ALLOWED_AGENT_CONFIG_KEYS, type AgentConfigKey } from "@/lib/agent-config/contracts";
import type {
  CompiledFactoryDefinition,
  FactoryDefinitionDiagnostic,
} from "@/lib/factory-definitions/compiler";
import type { SettingsFactoryDefinitionState } from "@/lib/factory-definitions/settings-contracts";
import type { SandboxProvider } from "@/lib/sandbox/types";

function configuredAgentKeys(config: SettingsPageData["agentConfig"]): AgentConfigKey[] {
  return ALLOWED_AGENT_CONFIG_KEYS.filter((key) => {
    const value = config[key];
    return typeof value === "number" || (typeof value === "string" && value.trim().length > 0);
  });
}

export function agentConfigFromFactoryDefinition(
  definition: CompiledFactoryDefinition,
): SettingsPageData["agentConfig"] {
  return {
    agent_provider: definition.agent.provider,
    agent_model: definition.agent.model,
    agent_effort: definition.agent.effort ?? "",
    concurrency_limit: definition.agent.concurrencyLimit,
    stall_timeout_ms: definition.agent.stallTimeoutMs,
    max_retries: definition.agent.maxRetries,
    max_turns: definition.agent.maxTurns,
  };
}

export function pipelineFromFactoryDefinition(
  currentPipeline: PipelineConfiguration | null,
  definition: CompiledFactoryDefinition,
): PipelineConfiguration {
  const existingStages = [
    ...(currentPipeline?.stages ?? []),
    ...(currentPipeline?.archivedStages ?? []),
  ];
  const activeStageIds = new Set(definition.stages.map((stage) => stage.id));

  const stages: PipelineStage[] = definition.stages.map((stage, index) => ({
    anyoneCanApprove: stage.anyoneCanApprove,
    approverMemberIds: [...stage.approverMemberIds],
    description: stage.description,
    id: stage.id,
    name: stage.name,
    pipelineId: definition.pipelineId,
    position: index + 1,
    promptTemplateMd: stage.promptTemplateMd,
    slug: stage.slug,
  }));

  const archivedStages = existingStages
    .filter((stage) => !activeStageIds.has(stage.id))
    .map((stage) => ({
      ...stage,
      archivedAt:
        "archivedAt" in stage && typeof stage.archivedAt === "string"
          ? stage.archivedAt
          : "1970-01-01T00:00:00.000Z",
    }));

  return {
    archivedStages,
    id: definition.pipelineId,
    isDefault: currentPipeline?.isDefault ?? true,
    name: currentPipeline?.name ?? "Default",
    operatingRulesMd: definition.operatingRulesMd,
    stages,
  };
}

function sandboxProviderDisplayName(provider: SandboxProvider): string {
  switch (provider) {
    case "vercel":
      return "Vercel Sandbox";
    case "e2b":
      return "E2B";
    case "daytona":
      return "Daytona";
  }
}

export function applySandboxProviderToSettingsData<
  T extends Pick<SettingsSetupData, "sandboxSettings" | "setupHealth">,
>(current: T, provider: SandboxProvider): T {
  const sandboxSettings = {
    ...current.sandboxSettings,
    activeProvider: provider,
  };
  const active = sandboxSettings.connections[provider];
  const vercel = sandboxSettings.connections.vercel;
  const activeProviderEnabled = sandboxSettings.enabledProviders.includes(provider);
  const displayName =
    provider === "vercel"
      ? (vercel?.projectName ?? vercel?.projectId ?? null)
      : provider === "e2b"
        ? (sandboxSettings.connections.e2b?.apiKeyPreview ?? null)
        : (sandboxSettings.connections.daytona?.target ??
          sandboxSettings.connections.daytona?.apiUrl ??
          null);

  return {
    ...current,
    sandboxSettings,
    setupHealth: {
      ...current.setupHealth,
      sandboxConnection: {
        connected: activeProviderEnabled && active?.status === "connected",
        connectionRevision: active ? String(active.connectionRevision) : null,
        displayName,
        lastValidationError: activeProviderEnabled
          ? (active?.lastValidationError ?? null)
          : `${sandboxProviderDisplayName(provider)} is disabled in this Wallie deployment. Switch to an enabled sandbox provider.`,
        provider,
        providerLabel: sandboxProviderDisplayName(provider),
        status: activeProviderEnabled ? (active?.status ?? "missing") : "error",
        updatedAt: active?.updatedAt ?? null,
      },
    },
  };
}

export function projectSettingsDataWithFactoryDefinition<
  T extends Pick<
    SettingsSetupData,
    "agentConfig" | "factoryDefinition" | "pipeline" | "sandboxSettings" | "setupHealth"
  >,
>(current: T, state: SettingsFactoryDefinitionState): T {
  if (!state.activeDefinition) {
    return {
      ...current,
      factoryDefinition: state,
    };
  }

  const definition = state.activeDefinition;
  const pipeline = pipelineFromFactoryDefinition(current.pipeline, definition);
  const agentConfig = agentConfigFromFactoryDefinition(definition);
  const configuredKeys = configuredAgentKeys(agentConfig);

  const withRuntime = {
    ...current,
    agentConfig,
    factoryDefinition: state,
    pipeline,
    setupHealth: {
      ...current.setupHealth,
      agentConfig: {
        configured: configuredKeys.length > 0,
        configuredKeys,
        status: configuredKeys.length > 0 ? ("present" as const) : ("missing" as const),
        values: agentConfig,
      },
      defaultPipeline: {
        configured: pipeline.stages.length > 0,
        pipelineId: pipeline.id,
        stageCount: pipeline.stages.length,
        status: pipeline.stages.length > 0 ? ("ready" as const) : ("missing" as const),
      },
    },
  };

  return applySandboxProviderToSettingsData(withRuntime, definition.sandboxProvider);
}

const AGENT_PATH_TO_KEY: Record<string, AgentConfigKey> = {
  provider: "agent_provider",
  model: "agent_model",
  effort: "agent_effort",
  concurrencyLimit: "concurrency_limit",
  stallTimeoutMs: "stall_timeout_ms",
  maxRetries: "max_retries",
  maxTurns: "max_turns",
};

export function mapCompilerDiagnosticsToAgentFieldErrors(
  diagnostics: readonly FactoryDefinitionDiagnostic[] | undefined,
): AgentConfigFieldErrors {
  const fieldErrors: AgentConfigFieldErrors = {};
  if (!diagnostics) return fieldErrors;
  for (const diagnostic of diagnostics) {
    if (diagnostic.path[0] !== "agent") continue;
    const subKey = diagnostic.path[1];
    if (typeof subKey !== "string") continue;
    const configKey = AGENT_PATH_TO_KEY[subKey];
    if (configKey && !fieldErrors[configKey]) {
      fieldErrors[configKey] = diagnostic.message;
    }
  }
  return fieldErrors;
}

export function formatCompilerDiagnosticsSummary(
  diagnostics: readonly FactoryDefinitionDiagnostic[] | undefined,
): string | null {
  if (!diagnostics || diagnostics.length === 0) return null;
  return diagnostics[0]?.message ?? null;
}

export function shortFactoryDigest(digest: string | null | undefined): string {
  if (!digest) return "";
  return digest.slice(0, 8);
}
