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

export type VerifyChecklistStatusTone = "accent" | "danger" | "neutral" | "success" | "warning";

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
    | "sandbox"
    | "vercel-sandbox";
  label: string;
  passed: boolean;
  statusLabel?: string;
  statusTone?: VerifyChecklistStatusTone;
  step: WorkspaceOnboardingStep;
};

export type VerifyBlocker = Omit<VerifyChecklistItem, "passed">;
export type VerifyChecklistMode = "onboarding" | "settings";

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
  claudeCodeConnection: OnboardingSetupHealth["claudeCodeConnection"];
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
          detail: input.claudeCodeConnection.connected
            ? "Current user has a connected Anthropic API key."
            : "Connect the current user's Anthropic API key.",
          id: "claude-code-connection",
          label: "Anthropic API key",
          passed: input.claudeCodeConnection.connected,
          step: "runtime",
        },
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

function capabilityCheckMatchesSandboxConnection(
  check: NonNullable<OnboardingSetupHealth["latestSandboxCapabilityCheck"]>,
  connection: NonNullable<OnboardingSetupHealth["sandboxConnection"]>,
) {
  return (
    connection.connected &&
    check.sandboxProvider === connection.provider &&
    check.sandboxConnectionRevision === connection.connectionRevision
  );
}

export function capabilityCheckMatchesCurrentSetup(health: OnboardingSetupHealth): boolean {
  const latestCheck = health.latestSandboxCapabilityCheck;
  if (!latestCheck) return false;
  const runtime = buildRuntimeReadiness({
    agentConfig: health.agentConfig.values,
    claudeCodeConnection: health.claudeCodeConnection,
    codexConnection: health.codexConnection,
    primaryRepositoryId: health.primaryRepositoryProfile.repositoryId,
    repositorySetup: health.repositorySetup,
  });
  const primaryRepositoryId = health.primaryRepositoryProfile.repositoryId;
  const repositoryMatches =
    Boolean(primaryRepositoryId) && latestCheck.githubRepositoryId === primaryRepositoryId;
  const pendingWithoutAgentMetadata =
    latestCheck.status === "running" &&
    latestCheck.agentProvider == null &&
    latestCheck.agentModel == null;
  const agentMatches =
    pendingWithoutAgentMetadata ||
    (latestCheck.agentProvider === runtime.provider && latestCheck.agentModel === runtime.model);
  const connectionMatches = health.sandboxConnection
    ? capabilityCheckMatchesSandboxConnection(latestCheck, health.sandboxConnection)
    : capabilityCheckMatchesLegacyVercelConnection(latestCheck, health.vercelSandboxConnection);

  return repositoryMatches && agentMatches && connectionMatches;
}

function capabilityCheckMatchesLegacyVercelConnection(
  check: NonNullable<OnboardingSetupHealth["latestSandboxCapabilityCheck"]>,
  connection: OnboardingSetupHealth["vercelSandboxConnection"],
) {
  return (
    connection.connected &&
    check.sandboxProvider === "vercel" &&
    check.sandboxVercelTeamId === connection.teamId &&
    check.sandboxVercelProjectId === connection.projectId
  );
}

function capabilityCheckIsPendingSandboxMetadata(
  check: NonNullable<OnboardingSetupHealth["latestSandboxCapabilityCheck"]>,
) {
  return (
    check.status === "running" &&
    check.sandboxProvider === null &&
    check.sandboxVercelTeamId === null &&
    check.sandboxVercelProjectId === null
  );
}

export function buildVerifyChecklist(input: {
  agentConfig: AgentConfigMap;
  health: OnboardingSetupHealth;
  mode?: VerifyChecklistMode;
  onboarding: WorkspaceOnboardingState;
}): VerifyChecklistItem[] {
  const runtimeReadiness = buildRuntimeReadiness({
    agentConfig: input.agentConfig,
    claudeCodeConnection: input.health.claudeCodeConnection,
    codexConnection: input.health.codexConnection,
    primaryRepositoryId: input.health.primaryRepositoryProfile.repositoryId,
    repositorySetup: input.health.repositorySetup,
  });
  const completedSteps = new Set(input.onboarding.completedSteps);
  const skippedSteps = new Set(input.onboarding.skippedSteps);
  const primaryRepositoryId = input.health.primaryRepositoryProfile.repositoryId;
  const latestCheck = input.health.latestSandboxCapabilityCheck;
  const sandboxConnection = input.health.sandboxConnection ?? {
    connected: input.health.vercelSandboxConnection.connected,
    connectionRevision: null,
    displayName:
      input.health.vercelSandboxConnection.projectName ??
      input.health.vercelSandboxConnection.projectId,
    lastValidationError: input.health.vercelSandboxConnection.lastValidationError,
    provider: "vercel" as const,
    providerLabel: "Vercel Sandbox",
    status: input.health.vercelSandboxConnection.status,
    updatedAt: input.health.vercelSandboxConnection.updatedAt,
  };
  const latestCheckMatchesPrimaryRepository =
    Boolean(primaryRepositoryId) && latestCheck?.githubRepositoryId === primaryRepositoryId;
  const latestCheckMatchesAgent =
    latestCheck !== null &&
    ((latestCheck.status === "running" &&
      latestCheck.agentProvider == null &&
      latestCheck.agentModel == null) ||
      (latestCheck.agentProvider === runtimeReadiness.provider &&
        latestCheck.agentModel === runtimeReadiness.model));
  const latestCheckMatchesSandboxConnection =
    latestCheckMatchesPrimaryRepository &&
    latestCheckMatchesAgent &&
    latestCheck !== null &&
    ((input.health.sandboxConnection
      ? capabilityCheckMatchesSandboxConnection(latestCheck, sandboxConnection)
      : capabilityCheckMatchesLegacyVercelConnection(
          latestCheck,
          input.health.vercelSandboxConnection,
        )) ||
      capabilityCheckIsPendingSandboxMetadata(latestCheck));
  const latestSelectedRepositoryCheckStatus = latestCheckMatchesPrimaryRepository
    ? latestCheckMatchesSandboxConnection
      ? latestCheck?.status
      : "stale"
    : null;
  const sandboxStatus = !sandboxConnection.connected
    ? ({ label: "Blocked", tone: "warning" } as const)
    : latestSelectedRepositoryCheckStatus === "success"
      ? ({ label: "Ready", tone: "success" } as const)
      : latestSelectedRepositoryCheckStatus === "running"
        ? ({ label: "Running", tone: "accent" } as const)
        : latestSelectedRepositoryCheckStatus === "error"
          ? ({ label: "Failed", tone: "danger" } as const)
          : latestSelectedRepositoryCheckStatus === "stale"
            ? ({ label: "Stale", tone: "warning" } as const)
            : primaryRepositoryId
              ? ({ label: "Not started", tone: "neutral" } as const)
              : ({ label: "Unavailable", tone: "neutral" } as const);
  const stepSatisfied = (step: WorkspaceOnboardingStep) =>
    completedSteps.has(step) || (canSkipOnboardingStep(step) && skippedSteps.has(step));
  const useSetupHealth = input.mode === "settings";
  const pipelinePassed = useSetupHealth
    ? input.health.defaultPipeline.configured
    : completedSteps.has("pipeline");
  const linearPassed = useSetupHealth
    ? input.health.linearKey.configured && input.health.linearRouting.configured
    : stepSatisfied("linear");
  const runtimePassed = useSetupHealth
    ? input.health.agentConfig.configured || stepSatisfied("runtime")
    : stepSatisfied("runtime");

  // In onboarding mode these three items track *step completion*, not readiness —
  // a seeded pipeline can be "Ready" in Health while its step is still unfinished.
  // Label that state as "Not finished" (neutral) instead of "Blocked" (warning) so
  // the checklist never contradicts the Health panel for the same noun. Settings
  // mode already tracks readiness, so its default Ready/Blocked vocabulary stands.
  const stepCompletionStatus = (
    passed: boolean,
  ): Pick<VerifyChecklistItem, "statusLabel" | "statusTone"> | undefined =>
    useSetupHealth
      ? undefined
      : passed
        ? { statusLabel: "Done", statusTone: "success" }
        : { statusLabel: "Not finished", statusTone: "neutral" };

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
        ? (input.health.primaryRepositoryProfile.fullName ?? "Repository profile saved.")
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
      detail: useSetupHealth
        ? input.health.defaultPipeline.configured
          ? `${input.health.defaultPipeline.stageCount} pipeline stages are configured.`
          : "Configure a default pipeline."
        : completedSteps.has("pipeline")
          ? "Pipeline step completed."
          : "Complete the pipeline step.",
      id: "pipeline",
      label: useSetupHealth ? "Pipeline configured" : "Pipeline completed",
      passed: pipelinePassed,
      step: "pipeline",
      ...stepCompletionStatus(pipelinePassed),
    },
    {
      detail: useSetupHealth
        ? linearPassed
          ? "Linear API key and routing are configured."
          : "Configure the Linear API key and routing."
        : stepSatisfied("linear")
          ? "Linear step completed or skipped."
          : "Complete the Linear step.",
      id: "linear",
      label: useSetupHealth ? "Linear configured" : "Linear completed",
      passed: linearPassed,
      step: "linear",
      ...stepCompletionStatus(linearPassed),
    },
    {
      detail: useSetupHealth
        ? runtimePassed
          ? input.health.agentConfig.configured
            ? "Agent runtime configuration is saved."
            : "Runtime setup was skipped."
          : "Configure agent runtime settings."
        : stepSatisfied("runtime")
          ? "Runtime step completed or skipped."
          : "Complete the Runtime step.",
      id: "runtime",
      label: useSetupHealth ? "Runtime configured" : "Runtime completed",
      passed: runtimePassed,
      step: "runtime",
      ...stepCompletionStatus(runtimePassed),
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
      detail: sandboxConnection.connected
        ? `Connected to ${sandboxConnection.displayName ?? sandboxConnection.providerLabel}.`
        : sandboxConnection.status === "error"
          ? (sandboxConnection.lastValidationError ??
            `The saved ${sandboxConnection.providerLabel} connection is invalid.`)
          : `Connect ${sandboxConnection.providerLabel} before running Wallie sessions.`,
      id: "vercel-sandbox",
      label: `${sandboxConnection.providerLabel} connected`,
      passed: sandboxConnection.connected,
      statusLabel: sandboxConnection.connected ? "Ready" : "Blocked",
      statusTone: sandboxConnection.connected ? "success" : "warning",
      step: "runtime",
    },
    {
      detail: !sandboxConnection.connected
        ? `Connect ${sandboxConnection.providerLabel} before running a capability check.`
        : latestSelectedRepositoryCheckStatus === "success"
          ? "Latest selected-repository sandbox capability check succeeded."
          : latestSelectedRepositoryCheckStatus === "running"
            ? "Sandbox capability check is still running."
            : latestSelectedRepositoryCheckStatus === "error"
              ? (latestCheck?.errorText ?? "Latest sandbox capability check failed.")
              : latestSelectedRepositoryCheckStatus === "stale"
                ? `Run a sandbox capability check for the connected ${sandboxConnection.providerLabel} account.`
                : primaryRepositoryId
                  ? "Run a sandbox capability check for the selected repository."
                  : "Save a repository profile before running a sandbox capability check.",
      id: "sandbox",
      label: "Sandbox capability check",
      passed: sandboxConnection.connected && latestSelectedRepositoryCheckStatus === "success",
      statusLabel: sandboxStatus.label,
      statusTone: sandboxStatus.tone,
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
