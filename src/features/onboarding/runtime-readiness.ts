import {
  type AgentConfigKey,
  type AgentProvider,
  ALLOWED_AGENT_CONFIG_KEYS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  isAgentConfigKey,
  modelMatchesProvider,
  normalizeAgentProviderName,
  parseAgentConfigValue,
} from "@/lib/agent-config/contracts";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingState,
  WorkspaceOnboardingStep,
} from "@/lib/onboarding/contracts";

export type AgentConfigMap = Partial<Record<AgentConfigKey, unknown>>;

export type RuntimeRequirement = {
  detail: string;
  id: string;
  label: string;
  passed: boolean;
  step: WorkspaceOnboardingStep;
};

export type RuntimeReadiness = {
  canComplete: boolean;
  invalidConfig: Array<{
    error: string;
    key: AgentConfigKey;
  }>;
  missingDefaultKeys: AgentConfigKey[];
  model: string;
  provider: AgentProvider;
  requirements: RuntimeRequirement[];
};

export type VerifyChecklistItem = {
  detail: string;
  id:
    | "github"
    | "linear"
    | "pipeline"
    | "provider-credentials"
    | "repository-profile"
    | "repository-setup"
    | "runtime"
    | "sandbox";
  label: string;
  passed: boolean;
  step: WorkspaceOnboardingStep;
};

export type VerifyBlocker = Omit<VerifyChecklistItem, "passed">;

export function agentConfigEntriesToMap(
  entries: Array<{ key: string; value: unknown }>,
): AgentConfigMap {
  const result: AgentConfigMap = {};
  for (const entry of entries) {
    if (isAgentConfigKey(entry.key)) {
      result[entry.key] = entry.value;
    }
  }
  return result;
}

export function configuredAgentConfigKeys(config: AgentConfigMap): AgentConfigKey[] {
  return ALLOWED_AGENT_CONFIG_KEYS.filter((key) => config[key] !== undefined);
}

export function resolveAgentConfigValue(key: AgentConfigKey, config: AgentConfigMap) {
  return config[key] ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS[key];
}

function resolveProvider(config: AgentConfigMap): AgentProvider {
  const rawProvider = resolveAgentConfigValue("agent_provider", config);
  return typeof rawProvider === "string"
    ? (normalizeAgentProviderName(rawProvider) ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider)
    : RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider;
}

function resolveModel(config: AgentConfigMap): string {
  const rawModel = resolveAgentConfigValue("agent_model", config);
  return typeof rawModel === "string" ? rawModel : RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_model;
}

export function buildRuntimeReadiness(input: {
  agentConfig: AgentConfigMap;
  anthropicApiKeyConfigured?: boolean;
  codexConnection: OnboardingSetupHealth["codexConnection"];
  primaryRepositoryId: string | null;
  repositorySetup: OnboardingSetupHealth["repositorySetup"];
  secretKeys: readonly string[];
}): RuntimeReadiness {
  const provider = resolveProvider(input.agentConfig);
  const model = resolveModel(input.agentConfig);
  const secretKeySet = new Set(input.secretKeys);
  const anthropicApiKeyConfigured =
    input.anthropicApiKeyConfigured ?? secretKeySet.has("ANTHROPIC_API_KEY");
  const missingDefaultKeys = ALLOWED_AGENT_CONFIG_KEYS.filter(
    (key) => input.agentConfig[key] === undefined,
  );
  const invalidConfig = ALLOWED_AGENT_CONFIG_KEYS.flatMap((key) => {
    const value = resolveAgentConfigValue(key, input.agentConfig);
    const parsed = parseAgentConfigValue(key, value);
    return parsed.ok ? [] : [{ key, error: parsed.error }];
  });
  const providerModelValid = modelMatchesProvider(provider, model);
  if (!providerModelValid) {
    invalidConfig.push({
      key: "agent_model",
      error:
        provider === "codex"
          ? 'Model must start with "gpt-", "o1", "o3", or "o4" for Codex.'
          : 'Model must start with "claude-" for Anthropic providers.',
    });
  }

  const requirements: RuntimeRequirement[] = [
    {
      detail: invalidConfig.length
        ? invalidConfig.map((item) => `${item.key}: ${item.error}`).join(" ")
        : "Agent configuration values are valid.",
      id: "agent-config",
      label: "Agent config",
      passed: invalidConfig.length === 0,
      step: "runtime",
    },
  ];

  switch (provider) {
    case "codex":
      requirements.push({
        detail: input.codexConnection.connected
          ? "Current user has a connected Codex account."
          : "Connect the current user's Codex account.",
        id: "codex-connection",
        label: "Codex account",
        passed: input.codexConnection.connected,
        step: "runtime",
      });
      break;
    case "anthropic-api":
      requirements.push({
        detail: anthropicApiKeyConfigured
          ? "ANTHROPIC_API_KEY is stored in workspace secrets."
          : "Add ANTHROPIC_API_KEY to workspace secrets.",
        id: "anthropic-key",
        label: "Anthropic API key",
        passed: anthropicApiKeyConfigured,
        step: "runtime",
      });
      break;
    case "claude-code":
      requirements.push(
        {
          detail: providerModelValid
            ? "Claude Code model uses an Anthropic-compatible claude-* id."
            : "Claude Code requires a claude-* model id.",
          id: "claude-model",
          label: "Claude model",
          passed: providerModelValid,
          step: "runtime",
        },
        {
          detail:
            input.repositorySetup.status === "ready" && input.repositorySetup.repositoryId
              ? "Selected repository setup is ready for sandboxed CLI runs."
              : "Selected repository Wallie setup must be ready before Claude Code can run.",
          id: "claude-repository",
          label: "Sandbox repository",
          passed:
            input.repositorySetup.status === "ready" &&
            Boolean(input.primaryRepositoryId) &&
            input.repositorySetup.repositoryId === input.primaryRepositoryId,
          step: "repository",
        },
      );
      break;
  }

  return {
    canComplete: requirements.every((requirement) => requirement.passed),
    invalidConfig,
    missingDefaultKeys,
    model,
    provider,
    requirements,
  };
}

export function buildVerifyChecklist(input: {
  agentConfig: AgentConfigMap;
  health: OnboardingSetupHealth;
  onboarding: WorkspaceOnboardingState;
}): VerifyChecklistItem[] {
  const runtimeReadiness = buildRuntimeReadiness({
    agentConfig: input.agentConfig,
    anthropicApiKeyConfigured: input.health.workspaceSecrets.anthropicApiKeyConfigured,
    codexConnection: input.health.codexConnection,
    primaryRepositoryId: input.health.primaryRepositoryProfile.repositoryId,
    repositorySetup: input.health.repositorySetup,
    secretKeys: input.health.workspaceSecrets.configuredKeys,
  });
  const completedSteps = new Set(input.onboarding.completedSteps);
  const primaryRepositoryId = input.health.primaryRepositoryProfile.repositoryId;
  const latestCheck = input.health.latestSandboxCapabilityCheck;

  return [
    {
      detail: input.health.githubInstallation.connected
        ? `Connected to ${input.health.githubInstallation.targetName ?? "GitHub"}.`
        : "Connect an active GitHub installation.",
      id: "github",
      label: "GitHub connected",
      passed: input.health.githubInstallation.connected,
      step: "github",
    },
    {
      detail:
        input.health.primaryRepositoryProfile.fullName ?? "Save a primary repository profile.",
      id: "repository-profile",
      label: "Primary repository profile saved",
      passed: input.health.primaryRepositoryProfile.configured,
      step: "repository",
    },
    {
      detail:
        input.health.repositorySetup.status === "ready"
          ? "Selected repository setup is ready."
          : `Selected repository setup is ${input.health.repositorySetup.status}.`,
      id: "repository-setup",
      label: "Selected repository setup ready",
      passed:
        input.health.repositorySetup.status === "ready" &&
        input.health.repositorySetup.repositoryId === primaryRepositoryId,
      step: "repository",
    },
    {
      detail: completedSteps.has("pipeline")
        ? "Pipeline step completed."
        : "Complete the pipeline step.",
      id: "pipeline",
      label: "Pipeline completed",
      passed: completedSteps.has("pipeline"),
      step: "pipeline",
    },
    {
      detail: completedSteps.has("linear") ? "Linear step completed." : "Complete the Linear step.",
      id: "linear",
      label: "Linear completed",
      passed: completedSteps.has("linear"),
      step: "linear",
    },
    {
      detail: completedSteps.has("runtime")
        ? "Runtime step completed."
        : "Complete the Runtime step.",
      id: "runtime",
      label: "Runtime completed",
      passed: completedSteps.has("runtime"),
      step: "runtime",
    },
    {
      detail: runtimeReadiness.canComplete
        ? `Provider requirements are satisfied for ${runtimeReadiness.provider}.`
        : runtimeReadiness.requirements
            .filter((requirement) => !requirement.passed)
            .map((requirement) => requirement.detail)
            .join(" "),
      id: "provider-credentials",
      label: "Provider credentials valid",
      passed: runtimeReadiness.canComplete,
      step: "runtime",
    },
    {
      detail:
        latestCheck?.status === "success"
          ? "Latest selected-repository sandbox capability check succeeded."
          : latestCheck?.status === "running"
            ? "Sandbox capability check is still running."
            : latestCheck?.status === "error"
              ? (latestCheck.errorText ?? "Latest sandbox capability check failed.")
              : "Run a sandbox capability check for the selected repository.",
      id: "sandbox",
      label: "Sandbox capability check succeeded",
      passed:
        latestCheck?.status === "success" &&
        Boolean(primaryRepositoryId) &&
        latestCheck.githubRepositoryId === primaryRepositoryId,
      step: "verify",
    },
  ];
}

export function verifyBlockersFromChecklist(checklist: VerifyChecklistItem[]): VerifyBlocker[] {
  return checklist
    .filter((item) => !item.passed)
    .map((item) => ({
      detail: item.detail,
      id: item.id,
      label: item.label,
      step: item.step,
    }));
}
