import {
  type AgentConfigKey,
  type AgentProvider,
  ALLOWED_AGENT_CONFIG_KEYS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  getRecommendedAgentConfigDefault,
  isAgentConfigKey,
  modelMatchesProvider,
  normalizeAgentProviderName,
  parseAgentConfigValue,
} from "@/lib/agent-config/contracts";
import { canSkipOnboardingStep } from "@/features/onboarding/flow";
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
  return config[key] ?? getRecommendedAgentConfigDefault(key, resolveProvider(config));
}

function resolveProvider(config: AgentConfigMap): AgentProvider {
  const rawProvider = config.agent_provider ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider;
  return typeof rawProvider === "string"
    ? (normalizeAgentProviderName(rawProvider) ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider)
    : RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider;
}

function resolveModel(config: AgentConfigMap): string {
  const rawModel = resolveAgentConfigValue("agent_model", config);
  return typeof rawModel === "string"
    ? rawModel
    : getRecommendedAgentConfigDefault("agent_model", resolveProvider(config)).toString();
}

export function buildRuntimeReadiness(input: {
  agentConfig: AgentConfigMap;
  codexConnection: OnboardingSetupHealth["codexConnection"];
  primaryRepositoryId: string | null;
  repositorySetup: OnboardingSetupHealth["repositorySetup"];
}): RuntimeReadiness {
  const provider = resolveProvider(input.agentConfig);
  const model = resolveModel(input.agentConfig);
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
          : 'Model must start with "claude-" for Claude Code.',
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
          ? "Current user has a connected Codex credential."
          : "Connect the current user's Codex credential.",
        id: "codex-connection",
        label: "Codex credential",
        passed: input.codexConnection.connected,
        step: "runtime",
      });
      break;
    case "claude-code":
      requirements.push(
        {
          detail: providerModelValid
            ? "Claude Code model uses a claude-* id."
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
    codexConnection: input.health.codexConnection,
    primaryRepositoryId: input.health.primaryRepositoryProfile.repositoryId,
    repositorySetup: input.health.repositorySetup,
  });
  const completedSteps = new Set(input.onboarding.completedSteps);
  const skippedSteps = new Set(input.onboarding.skippedSteps);
  const primaryRepositoryId = input.health.primaryRepositoryProfile.repositoryId;
  const latestCheck = input.health.latestSandboxCapabilityCheck;
  const latestCheckMatchesPrimaryRepository =
    Boolean(primaryRepositoryId) && latestCheck?.githubRepositoryId === primaryRepositoryId;
  const latestSelectedRepositoryCheckStatus = latestCheckMatchesPrimaryRepository
    ? latestCheck?.status
    : null;
  const stepSatisfied = (step: WorkspaceOnboardingStep) =>
    completedSteps.has(step) || (canSkipOnboardingStep(step) && skippedSteps.has(step));

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
      detail: input.health.primaryRepositoryProfile.configured
        ? (input.health.primaryRepositoryProfile.fullName ?? "Primary repository profile saved.")
        : input.health.selectedRepository.fullName
          ? `Analyze and save a repository profile for ${input.health.selectedRepository.fullName}.`
          : "Select a repository before saving a repository profile.",
      id: "repository-profile",
      label: "Selected repository profile saved",
      passed: input.health.primaryRepositoryProfile.configured,
      step: "repository",
    },
    {
      detail: input.health.selectedRepository.configured
        ? input.health.repositorySetup.status === "ready"
          ? "Selected repository setup is ready."
          : `Selected repository setup is ${input.health.repositorySetup.status}.`
        : "Select a repository before running Wallie setup.",
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
      detail: stepSatisfied("linear")
        ? "Linear step completed or skipped."
        : "Complete the Linear step.",
      id: "linear",
      label: "Linear completed",
      passed: stepSatisfied("linear"),
      step: "linear",
    },
    {
      detail: stepSatisfied("runtime")
        ? "Runtime step completed or skipped."
        : "Complete the Runtime step.",
      id: "runtime",
      label: "Runtime completed",
      passed: stepSatisfied("runtime"),
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
        latestSelectedRepositoryCheckStatus === "success"
          ? "Latest selected-repository sandbox capability check succeeded."
          : latestSelectedRepositoryCheckStatus === "running"
            ? "Sandbox capability check is still running."
            : latestSelectedRepositoryCheckStatus === "error"
              ? (latestCheck?.errorText ?? "Latest sandbox capability check failed.")
              : primaryRepositoryId
                ? "Run a sandbox capability check for the selected repository."
                : "Save a primary repository profile before running a sandbox capability check.",
      id: "sandbox",
      label: "Sandbox capability check succeeded",
      passed: latestSelectedRepositoryCheckStatus === "success",
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
