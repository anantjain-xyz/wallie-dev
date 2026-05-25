"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  ApplyAgentConfigDefaultsResponse,
  UpsertAgentConfigResponse,
} from "@/app/api/agent-config/route";
import { AGENT_PROVIDER_SELECT_OPTIONS } from "@/components/shared/agent-provider-options";
import { PlusIcon, XIcon } from "@/components/shared/icons";
import { SelectField, type SelectOption } from "@/components/ui/select";
import { GitHubConnectionPanel } from "@/features/github/github-connection-panel";
import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import {
  buildOnboardingAdvancePatch,
  buildOnboardingContinuePatch,
  buildOnboardingExitPatch,
  buildOnboardingRailNavigationPatch,
  buildOnboardingRepositorySelectionPatch,
  buildOnboardingSkipPatch,
  buildOnboardingStepCompletionPatch,
  canSkipOnboardingStep,
  getOnboardingStepRailItems,
  onboardingStepIndex,
  ONBOARDING_STEPS,
  type OnboardingStepDisplayState,
} from "@/features/onboarding/flow";
import { OnboardingLinearStep } from "@/features/onboarding/onboarding-linear-step";
import { OnboardingPipelineEditor } from "@/features/onboarding/onboarding-pipeline-editor";
import { buildRepositorySetupHealth } from "@/features/onboarding/repository-health";
import {
  buildRuntimeReadiness,
  buildVerifyChecklist,
  configuredAgentConfigKeys,
  resolveAgentConfigValue,
  verifyBlockersFromChecklist,
  type AgentConfigMap,
  type RuntimeReadiness,
} from "@/features/onboarding/runtime-readiness";
import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import { ProviderAccessPanel } from "@/features/settings/provider-access-panel";
import { RepositoryProfileEditor } from "@/features/repository-profile/repository-profile-editor";
import {
  mergeRepositoryOnboardingState,
  RepositoryMetadataPills,
  RepositorySetupControls,
  RepositorySetupMessages,
  repositorySetupCanAdvance,
  RepositorySetupStatusBadge,
} from "@/features/repositories/repository-setup-controls";
import type { FlashMessage } from "@/features/settings/settings-types";
import { codexCredentialTypeLabel } from "@/lib/codex/contracts";
import { upsertSecretPreview } from "@/features/settings/secret-previews";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import {
  type AgentConfigKey,
  AGENT_CONFIG_LIMITS,
  ALLOWED_AGENT_CONFIG_KEYS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  getRecommendedAgentConfigDefault,
  normalizeAgentProviderName,
  parseAgentConfigValue,
} from "@/lib/agent-config/contracts";
import { type AgentConfigDrafts, applyAgentConfigDraftChange } from "@/lib/agent-config/drafts";
import type { RepositoryOnboardingState } from "@/lib/repo-onboarding/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import type {
  SandboxCapabilityCheckLatestResponse,
  SandboxCapabilityCheckResponse,
  SandboxCapabilityCheckState,
} from "@/lib/sandbox-capabilities/contracts";
import type {
  UpsertWorkspaceSecretResponse,
  WorkspaceSecretPreview,
} from "@/lib/secrets/contracts";
import { workspaceBasePath, workspaceSettingsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type OnboardingPageClientProps = {
  initialData: WorkspaceOnboardingData;
};

export { RepositoryProfileEditor };

type HealthTone = "accent" | "danger" | "neutral" | "success" | "warning";

type HealthSummaryItem = {
  detail: string;
  label: string;
  tone: HealthTone;
  value: string;
};

type EditableProfile = RepositoryProfileState;
type FieldType = "number" | "select" | "text";
type OnboardingDataUpdate =
  | WorkspaceOnboardingData
  | ((currentData: WorkspaceOnboardingData) => WorkspaceOnboardingData);
type OnboardingDataChange = (update: OnboardingDataUpdate) => void;

type RuntimeCompletionState = {
  hasInvalidDrafts: boolean;
  hasUnsavedDrafts: boolean;
  readiness: RuntimeReadiness;
};

type FieldDescriptor = {
  configKey: AgentConfigKey;
  description: string;
  label: string;
  options?: readonly SelectOption[];
  placeholder?: string;
  type: FieldType;
};

type NewSecretDraftRow = {
  id: string;
  key: string;
  value: string;
};

const badgeToneClasses: Record<HealthTone, string> = {
  accent: "ui-badge-neutral",
  danger: "ui-badge-danger",
  neutral: "ui-badge-neutral",
  success: "ui-badge-success",
  warning: "ui-badge-warning",
};

const railStateClasses: Record<OnboardingStepDisplayState, string> = {
  active: "bg-accent-soft text-accent",
  available: "text-muted hover:bg-surface-strong hover:text-foreground",
  blocked: "text-muted opacity-55",
  completed: "text-muted hover:bg-surface-strong hover:text-foreground",
  skipped: "text-muted hover:bg-surface-strong hover:text-foreground",
};

function StepStateIcon({ state }: { state: OnboardingStepDisplayState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-2 w-2 rounded-full",
        state === "active" ? "bg-accent" : "bg-muted/60",
        state === "blocked" && "bg-border-strong",
      )}
    />
  );
}

function Badge({ children, tone }: { children: string; tone: HealthTone }) {
  return (
    <span className={cn("ui-badge whitespace-nowrap", badgeToneClasses[tone])}>
      <span className="ui-badge-dot" />
      {children}
    </span>
  );
}

function SecretValueInput({
  ariaLabel,
  disabled,
  onChange,
  value,
}: {
  ariaLabel: string;
  disabled: boolean;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <input
      aria-label={ariaLabel}
      autoComplete="off"
      className="ui-input h-10 min-w-0 flex-1 font-mono text-[13px]"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      type="password"
      value={value}
    />
  );
}

function HealthBadge({ children, tone }: { children: string; tone: HealthTone }) {
  const toneClassName =
    tone === "danger"
      ? "ui-badge-danger"
      : tone === "success"
        ? "ui-badge-success"
        : "ui-badge-neutral";

  return (
    <span className={cn("ui-badge whitespace-nowrap", toneClassName)}>
      <span className="ui-badge-dot" />
      {children}
    </span>
  );
}

function presenceBadge(configured: boolean) {
  return configured
    ? { tone: "success" as const, value: "Present" }
    : { tone: "warning" as const, value: "Missing" };
}

function normalizeSecretKey(key: string) {
  return key.trim().toUpperCase();
}

function secretPreviewLabel(secret: WorkspaceSecretPreview | undefined) {
  if (!secret) {
    return "Not saved";
  }

  return "Stored";
}

function repositoryVariableKeys(
  envSuggestions: readonly string[],
  workspaceSecrets: readonly WorkspaceSecretPreview[],
) {
  const keys = new Set<string>();
  const rows: string[] = [];
  const addKey = (rawKey: string) => {
    const key = normalizeSecretKey(rawKey);
    if (!key || key === "LINEAR_API_KEY" || keys.has(key)) {
      return;
    }
    keys.add(key);
    rows.push(key);
  };

  for (const key of envSuggestions) {
    addKey(key);
  }
  for (const secret of workspaceSecrets) {
    addKey(secret.key);
  }

  return rows;
}

function configValueToString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function buildAgentConfigDrafts(agentConfig: AgentConfigMap): AgentConfigDrafts {
  return {
    agent_provider: configValueToString(resolveAgentConfigValue("agent_provider", agentConfig)),
    agent_model: configValueToString(resolveAgentConfigValue("agent_model", agentConfig)),
    concurrency_limit: configValueToString(
      resolveAgentConfigValue("concurrency_limit", agentConfig),
    ),
    stall_timeout_ms: configValueToString(resolveAgentConfigValue("stall_timeout_ms", agentConfig)),
    max_retries: configValueToString(resolveAgentConfigValue("max_retries", agentConfig)),
  };
}

function parseDraftForKey(
  configKey: AgentConfigKey,
  type: FieldType,
  draft: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = draft.trim();

  if (type === "number") {
    if (trimmed === "") {
      return { ok: false, error: "Enter a number." };
    }
    const numeric = Number(trimmed);
    if (Number.isNaN(numeric)) {
      return { ok: false, error: "Must be a number." };
    }
    return parseAgentConfigValue(configKey, numeric);
  }

  if (type === "select") {
    if (trimmed === "") {
      return { ok: false, error: "Pick a value." };
    }
    return parseAgentConfigValue(configKey, trimmed);
  }

  return parseAgentConfigValue(configKey, trimmed);
}

function draftValueToConfigMap(drafts: AgentConfigDrafts, fields: readonly FieldDescriptor[]) {
  const config: AgentConfigMap = {};
  for (const field of fields) {
    const draft = drafts[field.configKey].trim();
    config[field.configKey] = field.type === "number" ? Number(draft) : draft;
  }
  return config;
}

export function isAgentConfigDraftDirty(
  configKey: AgentConfigKey,
  type: "number" | "select" | "text",
  draft: string,
  savedDraft: string,
): boolean {
  const validation = parseDraftForKey(configKey, type, draft);
  if (!validation.ok) {
    return draft !== savedDraft;
  }
  return configValueToString(validation.value) !== savedDraft;
}

function runtimeReadinessFromData(data: WorkspaceOnboardingData, agentConfig = data.agentConfig) {
  return buildRuntimeReadiness({
    agentConfig,
    claudeCodeConnection: data.setupHealth.claudeCodeConnection,
    codexConnection: data.setupHealth.codexConnection,
    primaryRepositoryId: data.setupHealth.primaryRepositoryProfile.repositoryId,
    repositorySetup: data.setupHealth.repositorySetup,
  });
}

function updateAgentConfigInData(
  currentData: WorkspaceOnboardingData,
  entries: Array<{ key: string; value: unknown }>,
): WorkspaceOnboardingData {
  const agentConfig = { ...currentData.agentConfig };
  for (const entry of entries) {
    if (ALLOWED_AGENT_CONFIG_KEYS.includes(entry.key as AgentConfigKey)) {
      agentConfig[entry.key as AgentConfigKey] = entry.value;
    }
  }
  const configuredKeys = configuredAgentConfigKeys(agentConfig);

  return {
    ...currentData,
    agentConfig,
    setupHealth: {
      ...currentData.setupHealth,
      agentConfig: {
        configured: configuredKeys.length > 0,
        configuredKeys,
        status: configuredKeys.length > 0 ? "present" : "missing",
        values: agentConfig,
      },
    },
  };
}

function updateSecretInData(
  currentData: WorkspaceOnboardingData,
  secret: UpsertWorkspaceSecretResponse["secret"],
): WorkspaceOnboardingData {
  const workspaceSecrets = upsertSecretPreview(currentData.workspaceSecrets, secret);
  const configuredKeys = [...new Set(workspaceSecrets.map((item) => item.key))].sort();

  return {
    ...currentData,
    linearSecret: secret.key === "LINEAR_API_KEY" ? secret : currentData.linearSecret,
    setupHealth: {
      ...currentData.setupHealth,
      linearKey:
        secret.key === "LINEAR_API_KEY"
          ? {
              configured: true,
              status: "present",
              updatedAt: secret.updatedAt,
            }
          : currentData.setupHealth.linearKey,
      workspaceSecrets: {
        configuredKeys,
      },
    },
    workspaceSecrets,
  };
}

function updateCodexConnectionInData(
  currentData: WorkspaceOnboardingData,
  status: CodexConnectionStatus,
): WorkspaceOnboardingData {
  const expiredOrReconnect = Boolean(status.expired || status.reconnectRequired);
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      codexConnection: {
        connected: status.connected,
        credentialType: status.credentialType ?? null,
        expiresAt: status.expiresAt ?? null,
        status: status.connected ? "connected" : expiredOrReconnect ? "expired" : "missing",
        updatedAt: status.updatedAt ?? null,
      },
    },
  };
}

function updateClaudeCodeConnectionInData(
  currentData: WorkspaceOnboardingData,
  status: ClaudeCodeConnectionStatus,
): WorkspaceOnboardingData {
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      claudeCodeConnection: {
        connected: status.connected,
        status: status.connected ? "connected" : "missing",
        updatedAt: status.updatedAt ?? null,
      },
    },
  };
}

export function updateSandboxCapabilityCheckInData(
  currentData: WorkspaceOnboardingData,
  check: SandboxCapabilityCheckState,
): WorkspaceOnboardingData {
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      latestSandboxCapabilityCheck: check,
    },
  };
}

function setupHealthItems(health: OnboardingSetupHealth): HealthSummaryItem[] {
  const github = health.githubInstallation.connected
    ? {
        detail: health.githubInstallation.targetName ?? "Connected installation",
        tone: "success" as const,
        value: "Connected",
      }
    : {
        detail: "No active installation",
        tone: "warning" as const,
        value: "Missing",
      };
  const pipeline = health.defaultPipeline.configured
    ? {
        detail: `${health.defaultPipeline.stageCount} stages`,
        tone: "success" as const,
        value: "Ready",
      }
    : {
        detail: "Default pipeline unavailable",
        tone: "warning" as const,
        value: "Missing",
      };
  const linearKey = presenceBadge(health.linearKey.configured);
  const linearRouting = presenceBadge(health.linearRouting.configured);
  const agentConfig = presenceBadge(health.agentConfig.configured);
  const selectedProvider =
    typeof health.agentConfig.values.agent_provider === "string"
      ? (normalizeAgentProviderName(health.agentConfig.values.agent_provider) ?? "codex")
      : "codex";
  const providerCredential =
    selectedProvider === "claude-code"
      ? {
          connected: health.claudeCodeConnection.connected,
          credentialLabel: health.claudeCodeConnection.connected ? "Anthropic API key" : null,
          expired: false,
          updatedAt: health.claudeCodeConnection.updatedAt,
        }
      : {
          connected: health.codexConnection.connected,
          credentialLabel: health.codexConnection.credentialType
            ? codexCredentialTypeLabel(health.codexConnection.credentialType)
            : null,
          expired: health.codexConnection.status === "expired",
          updatedAt: health.codexConnection.updatedAt,
        };
  const providerCredentialBadge = providerCredential.connected
    ? { tone: "success" as const, value: "Connected" }
    : providerCredential.expired
      ? { tone: "danger" as const, value: "Expired" }
      : { tone: "warning" as const, value: "Missing" };
  const sandbox = health.latestSandboxCapabilityCheck
    ? health.latestSandboxCapabilityCheck.status === "success"
      ? { tone: "success" as const, value: "Ready" }
      : health.latestSandboxCapabilityCheck.status === "running"
        ? { tone: "accent" as const, value: "Running" }
        : { tone: "danger" as const, value: "Error" }
    : { tone: "neutral" as const, value: "No check" };
  const sandboxDetail = health.latestSandboxCapabilityCheck
    ? `Checked ${formatRelativeTime(health.latestSandboxCapabilityCheck.checkedAt)}`
    : "Run a capability check";

  return [
    { detail: github.detail, label: "GitHub", tone: github.tone, value: github.value },
    {
      detail: health.selectedRepository.fullName ?? "No selected repository",
      label: "Repository",
      tone: health.selectedRepository.configured ? "success" : "warning",
      value: health.selectedRepository.configured ? "Selected" : "Missing",
    },
    {
      detail: health.primaryRepositoryProfile.fullName ?? "No saved profile",
      label: "Profile",
      tone: health.primaryRepositoryProfile.configured ? "success" : "warning",
      value: health.primaryRepositoryProfile.configured ? "Saved" : "Missing",
    },
    { detail: pipeline.detail, label: "Pipeline", tone: pipeline.tone, value: pipeline.value },
    {
      detail: health.linearKey.updatedAt ? "Credential stored" : "Workspace secret required",
      label: "Linear key",
      tone: linearKey.tone,
      value: linearKey.value,
    },
    {
      detail: health.linearRouting.updatedAt ? "Routes saved" : "Routing not mapped",
      label: "Linear routing",
      tone: linearRouting.tone,
      value: linearRouting.value,
    },
    {
      detail: health.agentConfig.configuredKeys.length
        ? health.agentConfig.configuredKeys.join(", ")
        : "Agent settings required",
      label: "Agent config",
      tone: agentConfig.tone,
      value: agentConfig.value,
    },
    {
      detail: providerCredential.expired
        ? "Provider credential expired"
        : providerCredential.connected && providerCredential.credentialLabel
          ? providerCredential.credentialLabel
          : "Provider credential required",
      label: "Provider access",
      tone: providerCredentialBadge.tone,
      value: providerCredentialBadge.value,
    },
    {
      detail: sandboxDetail,
      label: "Sandbox",
      tone: sandbox.tone,
      value: sandbox.value,
    },
  ];
}

function settingsHref(workspaceSlug: string, anchor: string) {
  return `${workspaceSettingsPath(workspaceSlug)}#${anchor}`;
}

function formatRelativeTime(value: string, nowMs = Date.now()) {
  const thenMs = Date.parse(value);
  if (!Number.isFinite(thenMs)) return "recently";

  const elapsedSeconds = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (elapsedSeconds < 45) return "just now";

  const units = [
    { max: 60, name: "second", seconds: 1 },
    { max: 60 * 60, name: "minute", seconds: 60 },
    { max: 24 * 60 * 60, name: "hour", seconds: 60 * 60 },
    { max: 7 * 24 * 60 * 60, name: "day", seconds: 24 * 60 * 60 },
    { max: 30 * 24 * 60 * 60, name: "week", seconds: 7 * 24 * 60 * 60 },
    { max: 365 * 24 * 60 * 60, name: "month", seconds: 30 * 24 * 60 * 60 },
    { max: Number.POSITIVE_INFINITY, name: "year", seconds: 365 * 24 * 60 * 60 },
  ] as const;

  const unit = units.find((candidate) => elapsedSeconds < candidate.max) ?? units[0];
  const count = Math.max(1, Math.floor(elapsedSeconds / unit.seconds));
  return `${count} ${unit.name}${count === 1 ? "" : "s"} ago`;
}

const AGENT_CONFIG_FIELDS: FieldDescriptor[] = [
  {
    configKey: "agent_provider",
    description: "Choose the runtime Wallie uses for coding-agent work.",
    label: "Agent provider",
    options: AGENT_PROVIDER_SELECT_OPTIONS,
    type: "select",
  },
  {
    configKey: "agent_model",
    description: "Model identifier passed to the selected agent provider.",
    label: "Agent model",
    placeholder: RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_model,
    type: "text",
  },
  {
    configKey: "concurrency_limit",
    description: `Parallel agent jobs (${AGENT_CONFIG_LIMITS.concurrency_limit.min}-${AGENT_CONFIG_LIMITS.concurrency_limit.max}).`,
    label: "Concurrency",
    placeholder: String(RECOMMENDED_AGENT_CONFIG_DEFAULTS.concurrency_limit),
    type: "number",
  },
  {
    configKey: "stall_timeout_ms",
    description: `Stall timeout in milliseconds (${AGENT_CONFIG_LIMITS.stall_timeout_ms.min.toLocaleString()}-${AGENT_CONFIG_LIMITS.stall_timeout_ms.max.toLocaleString()}).`,
    label: "Stall timeout",
    placeholder: String(RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms),
    type: "number",
  },
  {
    configKey: "max_retries",
    description: `Automatic retries (${AGENT_CONFIG_LIMITS.max_retries.min}-${AGENT_CONFIG_LIMITS.max_retries.max}).`,
    label: "Max retries",
    placeholder: String(RECOMMENDED_AGENT_CONFIG_DEFAULTS.max_retries),
    type: "number",
  },
];

function applyGithubHealth(
  health: OnboardingSetupHealth,
  github: WorkspaceGitHubData,
  selectedGithubRepositoryId: string | null,
): OnboardingSetupHealth {
  return {
    ...health,
    githubInstallation: {
      connected: Boolean(github.installation && !github.installation.suspended),
      installationId: github.installation?.installationId ?? null,
      status: github.installation ? "present" : "missing",
      suspended: github.installation?.suspended ?? null,
      targetName: github.installation?.targetName ?? null,
      updatedAt: github.installation?.updatedAt ?? null,
    },
    ...buildRepositorySetupHealth(github, selectedGithubRepositoryId),
  };
}

function RuntimeRequirementList({
  requirements,
}: {
  requirements: RuntimeReadiness["requirements"];
}) {
  return (
    <div className="space-y-2">
      {requirements.map((requirement) => (
        <div
          className="flex items-start justify-between gap-3 rounded-[6px] border border-border bg-surface px-3 py-2"
          key={requirement.id}
        >
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-foreground">{requirement.label}</p>
            <p className="mt-0.5 text-[12px] leading-5 text-muted">{requirement.detail}</p>
          </div>
          <Badge tone={requirement.passed ? "success" : "warning"}>
            {requirement.passed ? "Ready" : "Blocked"}
          </Badge>
        </div>
      ))}
    </div>
  );
}

function RuntimeStep({
  data,
  isSaving,
  onDataChange,
  onRuntimeStateChange,
}: {
  data: WorkspaceOnboardingData;
  isSaving: boolean;
  onDataChange: OnboardingDataChange;
  onRuntimeStateChange: (state: RuntimeCompletionState) => void;
}) {
  const [drafts, setDrafts] = useState<AgentConfigDrafts>(() =>
    buildAgentConfigDrafts(data.agentConfig),
  );
  const [secretValueDrafts, setSecretValueDrafts] = useState<Record<string, string>>({});
  const [newSecretRows, setNewSecretRows] = useState<NewSecretDraftRow[]>([]);
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const nextNewSecretRowId = useRef(1);
  const handleCodexStatusChange = useCallback(
    (status: CodexConnectionStatus) =>
      onDataChange((current) => updateCodexConnectionInData(current, status)),
    [onDataChange],
  );
  const handleClaudeCodeStatusChange = useCallback(
    (status: ClaudeCodeConnectionStatus) =>
      onDataChange((current) => updateClaudeCodeConnectionInData(current, status)),
    [onDataChange],
  );
  const fields = AGENT_CONFIG_FIELDS;
  const savedDrafts = buildAgentConfigDrafts(data.agentConfig);
  const fieldStatuses = fields.map((field) => {
    const draft = drafts[field.configKey];
    const validation = parseDraftForKey(field.configKey, field.type, draft);
    const isDirty = isAgentConfigDraftDirty(
      field.configKey,
      field.type,
      draft,
      savedDrafts[field.configKey],
    );
    return {
      draft,
      field,
      isDirty,
      validation,
      validationError: validation.ok ? null : validation.error,
    };
  });
  const providerFieldStatuses = fieldStatuses.filter(
    (status) =>
      status.field.configKey === "agent_provider" || status.field.configKey === "agent_model",
  );
  const executionFieldStatuses = fieldStatuses.filter(
    (status) =>
      status.field.configKey !== "agent_provider" && status.field.configKey !== "agent_model",
  );
  const hasInvalidDrafts = fieldStatuses.some((status) => status.validationError !== null);
  const hasUnsavedDrafts = fieldStatuses.some((status) => status.isDirty);
  const draftConfig = useMemo(() => draftValueToConfigMap(drafts, fields), [drafts, fields]);
  const readiness = useMemo(() => runtimeReadinessFromData(data, draftConfig), [data, draftConfig]);
  const readinessSignature = JSON.stringify({
    canComplete: readiness.canComplete,
    invalidConfig: readiness.invalidConfig,
    requirements: readiness.requirements.map((requirement) => [
      requirement.id,
      requirement.passed,
      requirement.detail,
    ]),
  });
  const selectedProvider = readiness.provider;
  const defaultsProvider = runtimeReadinessFromData(data).provider;
  const defaultDraftForKey = (key: AgentConfigKey) =>
    configValueToString(getRecommendedAgentConfigDefault(key, defaultsProvider));
  const envSuggestions = data.github.primaryProfile?.envKeySuggestions ?? [];
  const secretByKey = new Map(
    data.workspaceSecrets.map((secret) => [normalizeSecretKey(secret.key), secret]),
  );
  const repositoryVariables = repositoryVariableKeys(envSuggestions, data.workspaceSecrets);
  const repositorySecretDrafts = repositoryVariables
    .map((key) => ({ key, value: secretValueDrafts[key] ?? "" }))
    .filter((draft) => Boolean(draft.value.trim()));
  const completeNewSecretDrafts = newSecretRows.filter(
    (row) => Boolean(row.key.trim()) && Boolean(row.value.trim()),
  );
  const hasPartialNewSecretDraft = newSecretRows.some((row) => {
    const hasKey = Boolean(row.key.trim());
    const hasValue = Boolean(row.value.trim());
    return hasKey !== hasValue;
  });
  const missingDefaultKeys = ALLOWED_AGENT_CONFIG_KEYS.filter(
    (key) => data.agentConfig[key] === undefined && drafts[key] === defaultDraftForKey(key),
  );
  const canSaveConfig =
    data.canManage &&
    !isSaving &&
    busyAction === null &&
    !hasInvalidDrafts &&
    fieldStatuses.some((status) => status.isDirty);
  const canApplyDefaults =
    data.canManage && !isSaving && busyAction === null && missingDefaultKeys.length > 0;
  const canSaveRepositoryConfig =
    data.canManage &&
    !isSaving &&
    busyAction === null &&
    !hasPartialNewSecretDraft &&
    (repositorySecretDrafts.length > 0 || completeNewSecretDrafts.length > 0);

  useEffect(() => {
    onRuntimeStateChange({ hasInvalidDrafts, hasUnsavedDrafts, readiness });
  }, [hasInvalidDrafts, hasUnsavedDrafts, onRuntimeStateChange, readiness, readinessSignature]);

  function handleFieldChange(key: AgentConfigKey, next: string) {
    setDrafts((current) => applyAgentConfigDraftChange(current, key, next));
  }

  async function handleSaveConfig() {
    if (!canSaveConfig) return;
    setBusyAction("config");
    setRuntimeError(null);
    setRuntimeMessage(null);
    let savedCount = 0;
    let nextData = data;

    try {
      for (const status of fieldStatuses) {
        if (!status.isDirty || !status.validation.ok) continue;
        const response = await fetch("/api/agent-config", {
          body: JSON.stringify({
            key: status.field.configKey,
            value: status.validation.value,
            workspaceId: data.workspace.id,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });
        const body = (await response.json().catch(() => null)) as
          | (UpsertAgentConfigResponse & { error?: string })
          | null;
        if (!response.ok || !body) {
          throw new Error(body?.error ?? "Agent config save failed.");
        }
        savedCount += 1;
        nextData = updateAgentConfigInData(nextData, [body.entry]);
        if (ALLOWED_AGENT_CONFIG_KEYS.includes(body.entry.key as AgentConfigKey)) {
          setDrafts((current) => ({
            ...current,
            [body.entry.key]: configValueToString(body.entry.value),
          }));
        }
        onDataChange(nextData);
      }

      if (savedCount > 0) {
        setRuntimeMessage("Saved.");
      }
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Agent config save failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleApplyDefaults() {
    if (!canApplyDefaults) return;
    setBusyAction("defaults");
    setRuntimeError(null);
    setRuntimeMessage(null);

    try {
      const response = await fetch("/api/agent-config", {
        body: JSON.stringify({
          skipKeys: ALLOWED_AGENT_CONFIG_KEYS.filter(
            (key) => data.agentConfig[key] === undefined && drafts[key] !== defaultDraftForKey(key),
          ),
          workspaceId: data.workspace.id,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });
      const body = (await response.json().catch(() => null)) as
        | (ApplyAgentConfigDefaultsResponse & { error?: string })
        | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? "Applying defaults failed.");
      }
      onDataChange(updateAgentConfigInData(data, body.applied));
      setRuntimeMessage(
        body.applied.length
          ? `Applied ${body.applied.length} recommended default${body.applied.length === 1 ? "" : "s"}.`
          : "Recommended defaults were already saved.",
      );
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Applying defaults failed.");
    } finally {
      setBusyAction(null);
    }
  }

  function handleSecretDraftChange(key: string, value: string) {
    setSecretValueDrafts((current) => ({ ...current, [normalizeSecretKey(key)]: value }));
  }

  function handleAddNewSecretRow() {
    const rowId = `new-secret-${nextNewSecretRowId.current}`;
    nextNewSecretRowId.current += 1;
    setNewSecretRows((current) => [...current, { id: rowId, key: "", value: "" }]);
  }

  function handleNewSecretRowChange(
    id: string,
    field: keyof Pick<NewSecretDraftRow, "key" | "value">,
    value: string,
  ) {
    setNewSecretRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  }

  function handleRemoveNewSecretRow(id: string) {
    setNewSecretRows((current) => current.filter((row) => row.id !== id));
  }

  async function upsertWorkspaceSecret(key: string, value: string) {
    const normalizedKey = normalizeSecretKey(key);
    const response = await fetch("/api/secrets", {
      body: JSON.stringify({
        key: normalizedKey,
        value,
        workspaceId: data.workspace.id,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = (await response.json().catch(() => null)) as
      | (UpsertWorkspaceSecretResponse & { error?: string })
      | null;
    if (!response.ok || !body) {
      throw new Error(body?.error ?? "Workspace secret save failed.");
    }

    return body.secret;
  }

  async function handleSaveRepositoryConfig() {
    if (!canSaveRepositoryConfig) return;

    const entriesByKey = new Map<string, { key: string; value: string }>();
    for (const draft of repositorySecretDrafts) {
      entriesByKey.set(normalizeSecretKey(draft.key), draft);
    }
    for (const draft of completeNewSecretDrafts) {
      entriesByKey.set(normalizeSecretKey(draft.key), {
        key: draft.key,
        value: draft.value,
      });
    }
    const entries = [...entriesByKey.values()];
    setBusyAction("repository-config");
    setRuntimeError(null);
    setRuntimeMessage(null);

    try {
      let nextData = data;
      const savedKeys = new Set<string>();

      for (const entry of entries) {
        const secret = await upsertWorkspaceSecret(entry.key, entry.value);
        savedKeys.add(entry.key);
        savedKeys.add(normalizeSecretKey(entry.key));
        nextData = updateSecretInData(nextData, secret);
      }

      onDataChange(nextData);
      setSecretValueDrafts((current) => {
        const next = { ...current };
        for (const savedKey of savedKeys) {
          delete next[savedKey];
        }
        return next;
      });
      setNewSecretRows((current) =>
        current.filter((row) => !savedKeys.has(normalizeSecretKey(row.key)) || !row.value.trim()),
      );
      setRuntimeMessage(
        `Saved ${entries.length} environment variable${entries.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Workspace secret save failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-5">
      {runtimeError ? (
        <div
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
          role="alert"
        >
          {runtimeError}
        </div>
      ) : null}
      {runtimeMessage ? (
        <div
          className="rounded-[6px] border border-success/20 bg-success-soft px-3 py-2 text-[13px] text-success"
          role="status"
        >
          {runtimeMessage}
        </div>
      ) : null}

      <div className="rounded-[6px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Agent config</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Unset fields use Wallie&apos;s recommended defaults until saved.
            </p>
          </div>
          <button
            className="ui-button"
            disabled={!canApplyDefaults}
            onClick={() => void handleApplyDefaults()}
            type="button"
          >
            {busyAction === "defaults" ? "Applying..." : "Apply recommended defaults"}
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {providerFieldStatuses.map((status) => (
            <div className="block space-y-1.5" key={status.field.configKey}>
              {status.field.type === "select" && status.field.options ? (
                <SelectField
                  disabled={busyAction !== null}
                  label={status.field.label}
                  onValueChange={(value) => handleFieldChange(status.field.configKey, value)}
                  options={status.field.options}
                  value={status.draft}
                />
              ) : (
                <label className="block space-y-1.5">
                  <span className="text-[12px] font-medium text-muted">{status.field.label}</span>
                  <input
                    autoComplete="off"
                    className="ui-input"
                    disabled={busyAction !== null}
                    onChange={(event) =>
                      handleFieldChange(status.field.configKey, event.target.value)
                    }
                    placeholder={status.field.placeholder}
                    type={status.field.type === "number" ? "number" : "text"}
                    value={status.draft}
                  />
                </label>
              )}
              {status.validationError ? (
                <p className="text-[12px] leading-5 text-danger" role="alert">
                  {status.validationError}
                </p>
              ) : (
                <p className="text-[12px] leading-5 text-muted">{status.field.description}</p>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {executionFieldStatuses.map((status) => (
            <div className="block space-y-1.5" key={status.field.configKey}>
              {status.field.type === "select" && status.field.options ? (
                <SelectField
                  disabled={busyAction !== null}
                  label={status.field.label}
                  onValueChange={(value) => handleFieldChange(status.field.configKey, value)}
                  options={status.field.options}
                  value={status.draft}
                />
              ) : (
                <label className="block space-y-1.5">
                  <span className="text-[12px] font-medium text-muted">{status.field.label}</span>
                  <input
                    autoComplete="off"
                    className="ui-input"
                    disabled={busyAction !== null}
                    onChange={(event) =>
                      handleFieldChange(status.field.configKey, event.target.value)
                    }
                    placeholder={status.field.placeholder}
                    type={status.field.type === "number" ? "number" : "text"}
                    value={status.draft}
                  />
                </label>
              )}
              {status.validationError ? (
                <p className="text-[12px] leading-5 text-danger" role="alert">
                  {status.validationError}
                </p>
              ) : (
                <p className="text-[12px] leading-5 text-muted">{status.field.description}</p>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="min-w-0 text-[12px] leading-5 text-muted">
            {hasUnsavedDrafts
              ? "Save agent config before completing Runtime."
              : "No unsaved changes."}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="ui-button-primary"
              disabled={!canSaveConfig}
              onClick={() => void handleSaveConfig()}
              type="button"
            >
              {busyAction === "config" ? "Saving..." : "Save config"}
            </button>
          </div>
        </div>

        <div className="mt-4">
          <ProviderAccessPanel
            onClaudeCodeStatusChange={handleClaudeCodeStatusChange}
            onCodexStatusChange={handleCodexStatusChange}
            provider={selectedProvider}
            returnTo={`/w/${data.workspace.slug}/onboarding?step=runtime`}
            variant="embedded"
          />
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-[6px] border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-[14px] font-semibold text-foreground">
              Repository environment variables
            </h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Detected keys and saved workspace secrets are editable from this list.
            </p>
          </div>

          {repositoryVariables.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-muted">
              No repository env keys were detected.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {repositoryVariables.map((key) => {
                const secret = secretByKey.get(key);
                const draftValue = secretValueDrafts[key] ?? "";
                return (
                  <div className="space-y-2 px-4 py-3" key={key}>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <code className="break-all font-mono text-[13px] font-medium text-foreground">
                        {key}
                      </code>
                      <Badge tone={secret ? "success" : "neutral"}>
                        {secret ? secretPreviewLabel(secret) : "Not set"}
                      </Badge>
                    </div>

                    <SecretValueInput
                      ariaLabel={`Value for ${key}`}
                      disabled={busyAction !== null}
                      onChange={(value) => handleSecretDraftChange(key, value)}
                      value={draftValue}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {newSecretRows.length > 0 ? (
            <div className="divide-y divide-border border-t border-border">
              {newSecretRows.map((row) => (
                <div className="space-y-2 px-4 py-3" key={row.id}>
                  <div className="flex min-w-0 items-center gap-2">
                    <input
                      aria-label="New variable name"
                      autoCapitalize="characters"
                      autoComplete="off"
                      className="ui-input h-10 min-w-0 flex-1 font-mono text-[13px]"
                      disabled={busyAction !== null}
                      onChange={(event) =>
                        handleNewSecretRowChange(row.id, "key", event.target.value)
                      }
                      placeholder="SECRET_KEY"
                      spellCheck={false}
                      value={row.key}
                    />
                    <button
                      aria-label="Remove variable row"
                      className="ui-button h-10 w-10 shrink-0 !px-0 !py-0"
                      disabled={busyAction !== null}
                      onClick={() => handleRemoveNewSecretRow(row.id)}
                      title="Remove row"
                      type="button"
                    >
                      <XIcon className="h-4 w-4" />
                    </button>
                  </div>
                  <SecretValueInput
                    ariaLabel="New variable value"
                    disabled={busyAction !== null}
                    onChange={(value) => handleNewSecretRowChange(row.id, "value", value)}
                    value={row.value}
                  />
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4">
            <button
              className="ui-button gap-1.5"
              disabled={busyAction !== null}
              onClick={handleAddNewSecretRow}
              type="button"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              Add variable
            </button>
            <div className="flex items-center gap-3">
              {hasPartialNewSecretDraft ? (
                <span className="text-[12px] text-muted">Finish each added row before saving.</span>
              ) : null}
              <button
                className="ui-button-primary"
                disabled={!canSaveRepositoryConfig}
                onClick={() => void handleSaveRepositoryConfig()}
                type="button"
              >
                {busyAction === "repository-config" ? "Saving..." : "Save config"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-[6px] border border-border bg-surface p-4">
        <div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Runtime readiness</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Provider-specific requirements must pass before this step can complete.
            </p>
          </div>
        </div>
        <div className="mt-4">
          <RuntimeRequirementList requirements={readiness.requirements} />
        </div>
      </div>
    </div>
  );
}

function sandboxStatusTone(check: SandboxCapabilityCheckState | null): HealthTone {
  if (!check) return "neutral";
  if (check.status === "success") return "success";
  if (check.status === "error") return "danger";
  return "accent";
}

function VerifyStep({
  data,
  onDataChange,
  onSelectStep,
}: {
  data: WorkspaceOnboardingData;
  onDataChange: OnboardingDataChange;
  onSelectStep: (step: WorkspaceOnboardingStep) => void;
}) {
  const [check, setCheck] = useState(data.setupHealth.latestSandboxCapabilityCheck);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const primaryRepositoryId = data.setupHealth.primaryRepositoryProfile.repositoryId;
  const checklist = buildVerifyChecklist({
    agentConfig: data.agentConfig,
    health: {
      ...data.setupHealth,
      latestSandboxCapabilityCheck: check,
    },
    onboarding: data.onboarding,
  });
  const blockers = verifyBlockersFromChecklist(checklist);
  const isPolling = check?.status === "running";
  const canRunCapabilityCheck =
    data.canManage && Boolean(primaryRepositoryId) && busyAction === null && !isPolling;

  useEffect(() => {
    if (!data.canManage || !primaryRepositoryId || check?.status !== "running") return;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/workspaces/${data.workspace.id}/sandbox-capability-check?repositoryId=${encodeURIComponent(primaryRepositoryId)}`,
          { cache: "no-store" },
        );
        const body = (await response.json().catch(() => null)) as
          | (SandboxCapabilityCheckLatestResponse & { error?: string })
          | null;
        if (!response.ok || !body) {
          throw new Error(body?.error ?? "Capability check polling failed.");
        }
        if (cancelled || !body.check) return;
        const nextCheck = body.check;
        setCheck(nextCheck);
        onDataChange((currentData) => updateSandboxCapabilityCheckInData(currentData, nextCheck));
        if (nextCheck.status === "success" || nextCheck.status === "error") {
          window.clearInterval(timer);
        }
      } catch (error) {
        if (!cancelled) {
          setVerifyError(
            error instanceof Error ? error.message : "Capability check polling failed.",
          );
        }
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [check?.status, data.canManage, data.workspace.id, onDataChange, primaryRepositoryId]);

  async function runCapabilityCheck() {
    if (!canRunCapabilityCheck || !primaryRepositoryId) return;
    setBusyAction("sandbox");
    setVerifyError(null);

    try {
      const response = await fetch(
        `/api/workspaces/${data.workspace.id}/sandbox-capability-check`,
        {
          body: JSON.stringify({ repositoryId: primaryRepositoryId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );
      const body = (await response.json().catch(() => null)) as
        | (SandboxCapabilityCheckResponse & { error?: string })
        | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? "Sandbox capability check failed.");
      }
      setCheck(body.check);
      onDataChange((currentData) => updateSandboxCapabilityCheckInData(currentData, body.check));
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : "Sandbox capability check failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-5">
      {verifyError ? (
        <div
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
          role="alert"
        >
          {verifyError}
        </div>
      ) : null}

      <div className="rounded-[6px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Readiness checklist</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Resolve blockers in their owning setup step, then complete onboarding.
            </p>
          </div>
          <Badge tone={blockers.length === 0 ? "success" : "warning"}>
            {blockers.length === 0 ? "Ready" : `${blockers.length} blocked`}
          </Badge>
        </div>

        <div className="mt-4 space-y-2">
          {checklist.map((item) => (
            <div
              className="flex flex-col gap-3 rounded-[6px] border border-border bg-surface px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
              key={item.id}
            >
              <div className="min-w-0">
                <p className="text-[12px] font-medium text-foreground">{item.label}</p>
                <p className="mt-0.5 text-[12px] leading-5 text-muted">{item.detail}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={item.passed ? "success" : "warning"}>
                  {item.passed ? "Ready" : "Blocked"}
                </Badge>
                {!item.passed && item.step !== "verify" ? (
                  <button
                    className="ui-button"
                    data-step-link={item.step}
                    onClick={() => onSelectStep(item.step)}
                    type="button"
                  >
                    Open {ONBOARDING_STEPS.find((step) => step.id === item.step)?.shortTitle}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-[6px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Sandbox capability</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Checks run against the selected repository.
            </p>
          </div>
          <Badge tone={sandboxStatusTone(check)}>{check?.status ?? "No check"}</Badge>
        </div>
        {check?.errorText ? (
          <p className="mt-3 text-[12px] leading-5 text-danger">{check.errorText}</p>
        ) : null}
        {check ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {Object.entries(check.capabilities).map(([name, result]) => (
              <div
                className={cn(
                  "rounded-[6px] border px-3 py-2 text-[12px] leading-5",
                  result?.ok
                    ? "border-success/20 bg-success-soft text-success"
                    : "border-danger/20 bg-danger-soft text-danger",
                )}
                key={name}
              >
                <p className="font-semibold">{name}</p>
                <p>{result?.detail ?? "No detail recorded."}</p>
              </div>
            ))}
          </div>
        ) : null}
        <div className="mt-4 flex justify-end">
          <button
            className={check?.status === "error" ? "ui-button" : "ui-button-primary"}
            disabled={!canRunCapabilityCheck}
            onClick={() => void runCapabilityCheck()}
            type="button"
          >
            {busyAction === "sandbox"
              ? "Starting..."
              : isPolling
                ? "Checking..."
                : check?.status === "error"
                  ? "Retry capability check"
                  : "Run capability check"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RepositoryAnalysisStep({
  data,
  isSaving,
  onAnalyzeRepository,
  onInferRepository,
  onRepositoryOnboardingChange,
  onRepositoryProfileSaved,
  onRepositorySetupMessage,
  onSelectStep,
  onSelectGithubRepository,
  profileAnalyzing,
  profileDraft,
  profileError,
  profileSaving,
  updateProfileDraft,
}: {
  data: WorkspaceOnboardingData;
  isSaving: boolean;
  onAnalyzeRepository: (repository: WorkspaceGitHubRepository) => void;
  onInferRepository: (repository: WorkspaceGitHubRepository) => void;
  onRepositoryOnboardingChange: (
    repositoryId: string,
    onboarding: RepositoryOnboardingState,
  ) => void;
  onRepositoryProfileSaved: () => void;
  onRepositorySetupMessage: (message: FlashMessage) => void;
  onSelectStep: (step: WorkspaceOnboardingStep) => void;
  onSelectGithubRepository: (repository: WorkspaceGitHubRepository) => void;
  profileAnalyzing: boolean;
  profileDraft: EditableProfile | null;
  profileError: string | null;
  profileSaving: boolean;
  updateProfileDraft: (profile: EditableProfile, dirty?: boolean) => void;
}) {
  const selectedRepository = selectedRepositoryFromData(data);
  const repositories = data.github.repositories.filter((repository) => !repository.isArchived);

  if (repositories.length === 0) {
    return (
      <div className="rounded-[6px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-5 text-muted">
            Connect GitHub and sync repositories before analyzing repository setup.
          </p>
          <button className="ui-button" onClick={() => onSelectStep("github")} type="button">
            Open GitHub
          </button>
        </div>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border rounded-[10px] border border-border bg-surface">
      {repositories.map((repository) => {
        const selected = selectedRepository?.id === repository.id;
        const showProfileEditor = selected && Boolean(profileDraft);
        const rowProfileBusy = selected && (profileAnalyzing || profileSaving);
        const showSetupControls =
          Boolean(repository.onboarding.setupPrUrl) || repository.onboarding.status !== "ready";
        const showProfileAction =
          repository.onboarding.status === "ready" && !showProfileEditor && !rowProfileBusy;
        const showActionRow = showSetupControls || showProfileAction;

        return (
          <li className="flex flex-col gap-4 px-5 py-4" key={repository.id}>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  className="truncate text-[14px] font-semibold text-foreground transition-colors duration-150 hover:text-accent"
                  href={repository.htmlUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  {repository.fullName}
                </a>
                {selected ? <Badge tone="accent">Selected</Badge> : null}
                <RepositorySetupStatusBadge status={repository.onboarding.status} />
              </div>
              <RepositoryMetadataPills repository={repository} />
              {repository.description ? (
                <p className="text-[13px] leading-5 text-muted">{repository.description}</p>
              ) : null}
            </div>

            {showActionRow ? (
              <div className="flex flex-wrap items-center justify-start gap-2 border-t border-border pt-3 sm:justify-end">
                {showSetupControls ? (
                  <RepositorySetupControls
                    canManage={data.canManage && !isSaving}
                    onChange={onRepositoryOnboardingChange}
                    repository={repository}
                    setMessage={onRepositorySetupMessage}
                    workspaceId={data.workspace.id}
                  />
                ) : null}
                {showProfileAction ? (
                  <button
                    className={repository.profile ? "ui-button" : "ui-button-primary"}
                    disabled={!data.canManage || isSaving}
                    onClick={() =>
                      repository.profile
                        ? onSelectGithubRepository(repository)
                        : onAnalyzeRepository(repository)
                    }
                    type="button"
                  >
                    {repository.profile ? "Edit profile" : "Analyze repository"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {selected && profileError ? (
              <div
                className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
                role="alert"
              >
                {profileError}
              </div>
            ) : null}
            <RepositorySetupMessages repository={repository} />
            {showProfileEditor && profileDraft ? (
              <RepositoryProfileEditor
                canManage={data.canManage && !isSaving}
                isAnalyzing={profileAnalyzing}
                isSaving={profileSaving}
                onChange={updateProfileDraft}
                onInfer={() => onInferRepository(repository)}
                onSave={onRepositoryProfileSaved}
                profile={profileDraft}
              />
            ) : selected && profileAnalyzing ? (
              <div className="rounded-[6px] border border-border bg-surface px-3 py-2 text-[13px] text-muted">
                Analyzing repository...
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function StepBody({
  data,
  isSaving,
  onCompleteStep,
  onAnalyzeRepository,
  onDataChange,
  onInferRepository,
  onRefresh,
  onRepositoryOnboardingChange,
  onRepositoryProfileSaved,
  onRepositorySetupMessage,
  onRuntimeStateChange,
  onSelectStep,
  onSelectGithubRepository,
  profileAnalyzing,
  profileDraft,
  profileError,
  profileSaving,
  step,
  updateProfileDraft,
}: {
  data: WorkspaceOnboardingData;
  isSaving: boolean;
  onCompleteStep: (action: string) => Promise<void>;
  onAnalyzeRepository: (repository: WorkspaceGitHubRepository) => void;
  onDataChange: OnboardingDataChange;
  onInferRepository: (repository: WorkspaceGitHubRepository) => void;
  onRefresh: (action: string) => Promise<void>;
  onRepositoryOnboardingChange: (
    repositoryId: string,
    onboarding: RepositoryOnboardingState,
  ) => void;
  onRepositoryProfileSaved: () => void;
  onRepositorySetupMessage: (message: FlashMessage) => void;
  onRuntimeStateChange: (state: RuntimeCompletionState) => void;
  onSelectStep: (step: WorkspaceOnboardingStep) => void;
  onSelectGithubRepository: (repository: WorkspaceGitHubRepository) => void;
  profileAnalyzing: boolean;
  profileDraft: EditableProfile | null;
  profileError: string | null;
  profileSaving: boolean;
  step: WorkspaceOnboardingStep;
  updateProfileDraft: (profile: EditableProfile, dirty?: boolean) => void;
}) {
  const primaryHref =
    step === "github"
      ? settingsHref(data.workspace.slug, "github")
      : step === "pipeline"
        ? settingsHref(data.workspace.slug, "pipeline")
        : step === "linear"
          ? settingsHref(data.workspace.slug, "linear")
          : step === "runtime"
            ? settingsHref(data.workspace.slug, "coding-agent")
            : null;

  function updateGithub(github: WorkspaceGitHubData) {
    onDataChange({
      ...data,
      github,
      setupHealth: applyGithubHealth(
        data.setupHealth,
        github,
        data.onboarding.selectedGithubRepositoryId,
      ),
    });
  }

  if (step === "github") {
    return (
      <GitHubConnectionPanel
        canManage={data.canManage && !isSaving}
        github={data.github}
        onChange={updateGithub}
        source="onboarding"
        workspaceId={data.workspace.id}
      />
    );
  }

  if (step === "repository") {
    return (
      <RepositoryAnalysisStep
        data={data}
        isSaving={isSaving}
        onAnalyzeRepository={onAnalyzeRepository}
        onInferRepository={onInferRepository}
        onRepositoryOnboardingChange={onRepositoryOnboardingChange}
        onRepositoryProfileSaved={onRepositoryProfileSaved}
        onRepositorySetupMessage={onRepositorySetupMessage}
        onSelectStep={onSelectStep}
        onSelectGithubRepository={onSelectGithubRepository}
        profileAnalyzing={profileAnalyzing}
        profileDraft={profileDraft}
        profileError={profileError}
        profileSaving={profileSaving}
        updateProfileDraft={updateProfileDraft}
      />
    );
  }

  let controls: ReactNode;

  if (step === "pipeline") {
    controls = (
      <OnboardingPipelineEditor
        canManage={data.canManage}
        onCompleted={onCompleteStep}
        pipeline={data.pipeline}
        workspaceId={data.workspace.id}
        workspaceMembers={data.workspaceMembers}
      />
    );
  } else if (step === "linear") {
    controls = (
      <OnboardingLinearStep
        canManage={data.canManage}
        linearKeyConfigured={data.setupHealth.linearKey.configured}
        linearRouting={data.linearRouting}
        linearSecret={data.linearSecret}
        onCompleted={onCompleteStep}
        onRefresh={onRefresh}
        pipeline={data.pipeline}
        workspaceId={data.workspace.id}
      />
    );
  } else if (step === "runtime") {
    controls = (
      <RuntimeStep
        data={data}
        isSaving={isSaving}
        onDataChange={onDataChange}
        onRuntimeStateChange={onRuntimeStateChange}
      />
    );
  } else if (step === "verify") {
    controls = <VerifyStep data={data} onDataChange={onDataChange} onSelectStep={onSelectStep} />;
  } else {
    controls = (
      <div className="rounded-[6px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 text-[13px] leading-5 text-muted">
            Open the linked settings area to finish this step.
          </p>
          {primaryHref ? (
            <Link className="ui-button shrink-0" href={primaryHref}>
              Open settings
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  return <div className="space-y-5">{controls}</div>;
}

function StepRail({
  canSelect,
  items,
  onSelect,
}: {
  canSelect: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <ol className="space-y-1">
      {items.map((step) => (
        <li key={step.id}>
          <button
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] font-medium transition-colors",
              railStateClasses[step.displayState],
              (!canSelect || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canSelect || !step.isNavigable}
            onClick={() => onSelect(step.id)}
          >
            <StepStateIcon state={step.displayState} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{step.title}</span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function MobileStepControl({
  canSelect,
  items,
  onSelect,
}: {
  canSelect: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <div className="border-y border-border bg-surface px-4 py-2 lg:hidden">
      <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Setup steps">
        {items.map((step) => (
          <button
            key={step.id}
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "inline-flex h-9 min-w-[112px] items-center justify-center gap-1.5 rounded-[6px] border border-transparent px-2 text-[12px] font-medium",
              railStateClasses[step.displayState],
              (!canSelect || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canSelect || !step.isNavigable}
            onClick={() => onSelect(step.id)}
          >
            <StepStateIcon state={step.displayState} />
            <span className="truncate">{step.shortTitle}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SetupHealthSummary({ health }: { health: OnboardingSetupHealth }) {
  return (
    <aside className="h-fit min-w-0 lg:sticky lg:top-8">
      <h2 className="text-[13px] font-semibold tracking-tight text-foreground">Health</h2>
      <div className="mt-4 space-y-3">
        {setupHealthItems(health).map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-foreground">{item.label}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted">{item.detail}</p>
            </div>
            <HealthBadge tone={item.tone}>{item.value}</HealthBadge>
          </div>
        ))}
      </div>
    </aside>
  );
}

export function isRepositorySelectionCurrent(
  latestSelectedRepositoryId: string | null,
  repositoryId: string,
) {
  return latestSelectedRepositoryId === repositoryId;
}

export function applySavedRepositoryProfileToData(
  currentData: WorkspaceOnboardingData,
  profile: EditableProfile,
): WorkspaceOnboardingData {
  const nextGithub: WorkspaceGitHubData = {
    ...currentData.github,
    primaryProfile: profile,
    repositories: currentData.github.repositories.map((repository) => ({
      ...repository,
      profile:
        repository.id === profile.githubRepositoryId
          ? profile
          : repository.profile
            ? { ...repository.profile, isPrimary: false }
            : null,
    })),
  };

  return {
    ...currentData,
    github: nextGithub,
    setupHealth: applyGithubHealth(
      currentData.setupHealth,
      nextGithub,
      currentData.onboarding.selectedGithubRepositoryId,
    ),
  };
}

export function buildRepositoryProfileCompletionPatch(
  onboarding: WorkspaceOnboardingData["onboarding"],
): WorkspaceOnboardingUpdatePayload | null {
  if (onboarding.currentStep !== "repository") return null;
  return buildOnboardingStepCompletionPatch(onboarding);
}

function initialProfileDraft(data: WorkspaceOnboardingData): EditableProfile | null {
  const selectedRepositoryId =
    data.onboarding.selectedGithubRepositoryId ?? data.github.primaryProfile?.githubRepositoryId;
  if (!selectedRepositoryId) return null;

  const selectedRepository = data.github.repositories.find(
    (repository) => repository.id === selectedRepositoryId,
  );
  if (selectedRepository?.profile) return selectedRepository.profile;

  return data.github.primaryProfile?.githubRepositoryId === selectedRepositoryId
    ? data.github.primaryProfile
    : null;
}

function selectedRepositoryFromData(data: WorkspaceOnboardingData) {
  const selectedRepositoryId =
    data.onboarding.selectedGithubRepositoryId ?? data.github.primaryProfile?.githubRepositoryId;
  if (!selectedRepositoryId) return null;
  return (
    data.github.repositories.find((repository) => repository.id === selectedRepositoryId) ?? null
  );
}

function canCompleteGitHubSetupStep(data: WorkspaceOnboardingData) {
  return (
    data.setupHealth.githubInstallation.connected &&
    data.github.repositories.some((repository) => !repository.isArchived)
  );
}

function hasSelectedRepositoryProfile(data: WorkspaceOnboardingData) {
  const selectedRepositoryId =
    data.onboarding.selectedGithubRepositoryId ?? data.github.primaryProfile?.githubRepositoryId;
  return (
    Boolean(selectedRepositoryId) &&
    data.setupHealth.primaryRepositoryProfile.configured &&
    data.setupHealth.primaryRepositoryProfile.repositoryId === selectedRepositoryId
  );
}

function canCompleteRepositoryStep(data: WorkspaceOnboardingData) {
  return (
    hasSelectedRepositoryProfile(data) &&
    repositorySetupCanAdvance(data.setupHealth.repositorySetup.status)
  );
}

function selectOnboardingStepInData(
  currentData: WorkspaceOnboardingData,
  step: WorkspaceOnboardingStep,
): WorkspaceOnboardingData {
  if (currentData.onboarding.currentStep === step) return currentData;

  return {
    ...currentData,
    onboarding: {
      ...currentData.onboarding,
      currentStep: step,
      status:
        currentData.canManage && currentData.onboarding.status !== "completed"
          ? "in_progress"
          : currentData.onboarding.status,
    },
  };
}

export function scrollOnboardingSetupToTop(target?: {
  scrollTo: (options: ScrollToOptions) => void;
}) {
  const scrollTarget = target ?? (typeof window === "undefined" ? null : window);
  scrollTarget?.scrollTo({ behavior: "auto", left: 0, top: 0 });
}

export function OnboardingPageClient({ initialData }: OnboardingPageClientProps) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [error, setError] = useState<string | null>(null);
  const [profileAction, setProfileAction] = useState<"analyzing" | "saving" | null>(null);
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileDraft, setProfileDraft] = useState<EditableProfile | null>(() =>
    initialProfileDraft(initialData),
  );
  const [profileError, setProfileError] = useState<string | null>(null);
  const [runtimeCompletionState, setRuntimeCompletionState] = useState<RuntimeCompletionState>(
    () => {
      const readiness = runtimeReadinessFromData(initialData);
      return {
        hasInvalidDrafts: false,
        hasUnsavedDrafts: false,
        readiness,
      };
    },
  );
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(
    initialData.onboarding.selectedGithubRepositoryId ??
      initialData.github.primaryProfile?.githubRepositoryId ??
      null,
  );
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const latestDataRef = useRef(data);
  const selectedRepositoryIdRef = useRef(selectedRepositoryId);
  const previousStepRef = useRef(initialData.onboarding.currentStep);
  const onboarding = data.onboarding;
  latestDataRef.current = data;
  selectedRepositoryIdRef.current = selectedRepositoryId;
  const updateData = useCallback((update: OnboardingDataUpdate) => {
    setData((currentData) => {
      const nextData = typeof update === "function" ? update(currentData) : update;
      latestDataRef.current = nextData;
      return nextData;
    });
  }, []);
  const activeStep = ONBOARDING_STEPS.find((step) => step.id === onboarding.currentStep)!;
  const railItems = useMemo(() => getOnboardingStepRailItems(onboarding), [onboarding]);
  const canGoBack = onboardingStepIndex(onboarding.currentStep) > 0;
  const isCompleted = onboarding.status === "completed";
  const isSaving = savingAction !== null;
  const profileAnalyzing = profileAction === "analyzing";
  const profileSaving = profileAction === "saving";
  const profileBusy = profileAction !== null;
  const activeStepAlreadyResolved =
    onboarding.completedSteps.includes(activeStep.id) ||
    onboarding.skippedSteps.includes(activeStep.id);
  const pipelineEditorUnavailable = activeStep.id === "pipeline" && !data.pipeline;
  const linearRoutingUnavailable =
    activeStep.id === "linear" && (!data.pipeline || data.pipeline.stages.length === 0);
  const inlineCompletionUnavailable = pipelineEditorUnavailable || linearRoutingUnavailable;
  const requiresInlineCompletion =
    (activeStep.id === "pipeline" || activeStep.id === "linear") &&
    !inlineCompletionUnavailable &&
    !activeStepAlreadyResolved;
  const githubContinueBlocked = activeStep.id === "github" && !canCompleteGitHubSetupStep(data);
  const repositoryContinueBlocked =
    activeStep.id === "repository" && !canCompleteRepositoryStep(data);
  const runtimeCompletionBlocked =
    activeStep.id === "runtime" &&
    !activeStepAlreadyResolved &&
    (!runtimeCompletionState.readiness.canComplete ||
      runtimeCompletionState.hasInvalidDrafts ||
      runtimeCompletionState.hasUnsavedDrafts);
  const verifyChecklist = buildVerifyChecklist({
    agentConfig: data.agentConfig,
    health: data.setupHealth,
    onboarding: data.onboarding,
  });
  const verifyCompletionBlocked =
    activeStep.id === "verify" && verifyChecklist.some((item) => !item.passed);
  const skipAllowed = canSkipOnboardingStep(onboarding.currentStep);

  useEffect(() => {
    if (previousStepRef.current === onboarding.currentStep) return;
    previousStepRef.current = onboarding.currentStep;
    scrollOnboardingSetupToTop();
  }, [onboarding.currentStep]);

  async function persistOnboarding(payload: WorkspaceOnboardingUpdatePayload, action: string) {
    if (!data.canManage || saveInFlightRef.current) return null;

    saveInFlightRef.current = true;
    setSavingAction(action);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding`, {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to save onboarding state.");
      }

      const nextData = (await response.json()) as WorkspaceOnboardingData;
      latestDataRef.current = nextData;
      setData(nextData);
      router.refresh();
      return nextData;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save onboarding state.");
      return null;
    } finally {
      saveInFlightRef.current = false;
      setSavingAction(null);
    }
  }

  async function refreshOnboarding(action: string) {
    if (!data.canManage) return null;

    setSavingAction(action);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding`, {
        method: "GET",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to refresh onboarding state.");
      }

      const nextData = (await response.json()) as WorkspaceOnboardingData;
      latestDataRef.current = nextData;
      setData(nextData);
      router.refresh();
      return nextData;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to refresh onboarding state.");
      return null;
    } finally {
      setSavingAction(null);
    }
  }

  async function completeCurrentStep(action: string) {
    const patch = buildOnboardingStepCompletionPatch(latestDataRef.current.onboarding);
    if (!patch) return;

    const nextData = await persistOnboarding(patch, action);
    if (!nextData) {
      throw new Error("Failed to save onboarding state.");
    }
  }

  async function continueSetup() {
    if (activeStep.id === "verify") {
      await completeOnboarding();
      return;
    }

    if (inlineCompletionUnavailable) {
      const patch = buildOnboardingAdvancePatch(onboarding);
      if (!patch) return;
      await persistOnboarding(patch, "continue");
      return;
    }

    await persistOnboarding(buildOnboardingContinuePatch(onboarding), "continue");
  }

  async function completeOnboarding() {
    if (!data.canManage || saveInFlightRef.current || verifyCompletionBlocked) return;

    saveInFlightRef.current = true;
    setSavingAction("complete");
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding/complete`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | (WorkspaceOnboardingData & {
            blockers?: ReturnType<typeof verifyBlockersFromChecklist>;
            error?: string;
          })
        | null;

      if (!response.ok || !body || "error" in body) {
        const blockerText = body?.blockers?.length
          ? ` Blocked: ${body.blockers.map((blocker) => blocker.label).join(", ")}.`
          : "";
        throw new Error((body?.error ?? "Failed to complete onboarding.") + blockerText);
      }

      latestDataRef.current = body;
      setData(body);
      router.refresh();
      router.push(workspaceBasePath(body.workspace.slug));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to complete onboarding.");
    } finally {
      saveInFlightRef.current = false;
      setSavingAction(null);
    }
  }

  async function skipStep() {
    const patch = buildOnboardingSkipPatch(onboarding);
    if (!patch) return;
    await persistOnboarding(patch, "skip");
  }

  async function goBack() {
    const previousStep = ONBOARDING_STEPS[onboardingStepIndex(onboarding.currentStep) - 1]?.id;
    if (!previousStep) return;
    const patch = buildOnboardingRailNavigationPatch(onboarding, previousStep);
    if (!patch) return;
    await persistOnboarding(patch, "back");
  }

  async function selectStep(step: WorkspaceOnboardingStep) {
    const currentData = latestDataRef.current;
    const patch = buildOnboardingRailNavigationPatch(currentData.onboarding, step);
    const nextData = selectOnboardingStepInData(currentData, step);
    if (nextData !== currentData) {
      latestDataRef.current = nextData;
      setData(nextData);
    }
    if (!data.canManage || !patch) return;
    await persistOnboarding(patch, `rail:${step}`);
  }

  async function exitSetup() {
    const patch = data.canManage ? buildOnboardingExitPatch(onboarding) : null;
    const nextData = patch ? await persistOnboarding(patch, "exit") : data;
    if (nextData) {
      router.push(workspaceBasePath(data.workspace.slug));
    }
  }

  function updateProfileDraft(nextProfile: EditableProfile, dirty = false) {
    setProfileDraft(nextProfile);
    setProfileDirty(dirty);
  }

  async function inferRepositoryProfile(repository: WorkspaceGitHubRepository) {
    selectedRepositoryIdRef.current = repository.id;
    setSelectedRepositoryId(repository.id);
    setProfileDraft(null);
    setProfileDirty(false);
    setProfileError(null);
    setProfileAction("analyzing");

    try {
      const response = await fetch(
        `/api/workspaces/${data.workspace.id}/repositories/${repository.id}/inference`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to infer repository setup.");
      }

      const body = (await response.json()) as { profile: EditableProfile };
      if (!isRepositorySelectionCurrent(selectedRepositoryIdRef.current, repository.id)) return;
      setProfileDraft(body.profile);
    } catch (caught) {
      if (!isRepositorySelectionCurrent(selectedRepositoryIdRef.current, repository.id)) return;
      setProfileError(
        caught instanceof Error ? caught.message : "Failed to infer repository setup.",
      );
    } finally {
      if (isRepositorySelectionCurrent(selectedRepositoryIdRef.current, repository.id)) {
        setProfileAction(null);
      }
    }
  }

  async function selectGithubRepository(repository: WorkspaceGitHubRepository): Promise<boolean> {
    setProfileError(null);

    const patch = buildOnboardingRepositorySelectionPatch(
      latestDataRef.current.onboarding,
      repository.id,
      selectedRepositoryFromData(latestDataRef.current)?.id ?? null,
    );
    if (!patch) {
      selectedRepositoryIdRef.current = repository.id;
      setSelectedRepositoryId(repository.id);
      setProfileDirty(false);
      setProfileAction(null);
      setProfileDraft(repository.profile ?? null);
      return true;
    }

    const nextData = await persistOnboarding(patch, "repository-selection");
    if (!nextData) return false;

    selectedRepositoryIdRef.current = repository.id;
    setSelectedRepositoryId(repository.id);
    setProfileDirty(false);
    setProfileAction(null);
    const selectedRepository = nextData.github.repositories.find(
      (item) => item.id === repository.id,
    );
    setProfileDraft(selectedRepository?.profile ?? null);
    return true;
  }

  async function analyzeRepository(repository: WorkspaceGitHubRepository) {
    const currentSelectedRepositoryId = selectedRepositoryFromData(latestDataRef.current)?.id;
    if (currentSelectedRepositoryId !== repository.id) {
      const selected = await selectGithubRepository(repository);
      if (!selected) return;
    }

    await inferRepositoryProfile(repository);
  }

  function updateRepositoryOnboarding(repositoryId: string, onboarding: RepositoryOnboardingState) {
    updateData((currentData) => {
      const nextGithub = {
        ...currentData.github,
        repositories: mergeRepositoryOnboardingState(
          currentData.github.repositories,
          repositoryId,
          onboarding,
        ),
      };

      return {
        ...currentData,
        github: nextGithub,
        setupHealth: applyGithubHealth(
          currentData.setupHealth,
          nextGithub,
          currentData.onboarding.selectedGithubRepositoryId,
        ),
      };
    });
  }

  function handleRepositorySetupMessage(message: FlashMessage) {
    setError(message.kind === "error" ? message.text : null);
  }

  async function saveRepositoryProfile() {
    if (!profileDraft || !selectedRepositoryId || profileBusy) return;

    const repositoryIdToSave = selectedRepositoryId;
    const profileToSave = profileDraft;
    setProfileAction("saving");
    setProfileError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/repository-profile`, {
        body: JSON.stringify({
          buildCommand: profileToSave.buildCommand,
          envKeySuggestions: profileToSave.envKeySuggestions,
          frameworkHints: profileToSave.frameworkHints,
          githubRepositoryId: repositoryIdToSave,
          inferenceConfidence: profileDirty ? "manual" : profileToSave.inferenceConfidence,
          inferenceSources: profileToSave.inferenceSources,
          installCommand: profileToSave.installCommand,
          languageHints: profileToSave.languageHints,
          packageManager: profileToSave.packageManager,
          setupNotes: profileToSave.setupNotes,
          testCommand: profileToSave.testCommand,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to save repository profile.");
      }

      const body = (await response.json()) as { profile: EditableProfile };
      const nextData = applySavedRepositoryProfileToData(latestDataRef.current, body.profile);
      latestDataRef.current = nextData;
      setData(nextData);

      if (isRepositorySelectionCurrent(selectedRepositoryIdRef.current, repositoryIdToSave)) {
        setProfileDraft(body.profile);
        setProfileDirty(false);
      }

      const completionPatch = canCompleteRepositoryStep(nextData)
        ? buildRepositoryProfileCompletionPatch(latestDataRef.current.onboarding)
        : null;
      if (completionPatch) {
        await persistOnboarding(completionPatch, "repository-profile");
      }
    } catch (caught) {
      setProfileError(
        caught instanceof Error ? caught.message : "Failed to save repository profile.",
      );
    } finally {
      setProfileAction(null);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-surface text-foreground">
      <header className="mx-auto flex w-full max-w-[1180px] flex-wrap items-start justify-between gap-x-6 gap-y-3 px-6 pb-8 pt-10 sm:px-8">
        <div className="min-w-0 space-y-2">
          <h1 className="text-[28px] font-semibold tracking-tight text-foreground">
            Set up {data.workspace.name}
          </h1>
          <p className="max-w-2xl text-[14px] leading-6 text-muted">
            Finish the required connections before starting sessions.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!data.canManage ? <Badge tone="neutral">Read only</Badge> : null}
          <button
            type="button"
            className="ui-button"
            disabled={isSaving}
            onClick={() => void exitSetup()}
          >
            {savingAction === "exit" ? "Exiting..." : "Exit setup"}
          </button>
        </div>
      </header>

      <MobileStepControl canSelect={!isSaving} items={railItems} onSelect={selectStep} />

      <main
        id="main-content"
        className="mx-auto grid w-full max-w-[1180px] flex-1 grid-cols-1 gap-10 px-6 pb-28 sm:px-8 lg:grid-cols-[180px_minmax(0,1fr)_260px] lg:gap-12"
      >
        <aside className="hidden lg:block">
          <div className="sticky top-8">
            <StepRail canSelect={!isSaving} items={railItems} onSelect={selectStep} />
          </div>
        </aside>

        <section className="min-w-0">
          <div className="settings-section-header mb-6">
            <div className="min-w-0">
              <h2 className="text-[18px] font-semibold tracking-tight text-foreground">
                {activeStep.title}
              </h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
                {activeStep.description}
              </p>
            </div>
          </div>

          {error ? (
            <div
              className="mt-5 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="mt-6">
            <StepBody
              data={data}
              isSaving={isSaving}
              onCompleteStep={completeCurrentStep}
              onAnalyzeRepository={(repository) => void analyzeRepository(repository)}
              onDataChange={updateData}
              onInferRepository={(repository) => void inferRepositoryProfile(repository)}
              onRefresh={async (action) => {
                const nextData = await refreshOnboarding(action);
                if (!nextData) {
                  throw new Error("Failed to refresh onboarding state.");
                }
              }}
              onRepositoryOnboardingChange={updateRepositoryOnboarding}
              onRepositoryProfileSaved={() => void saveRepositoryProfile()}
              onRepositorySetupMessage={handleRepositorySetupMessage}
              onRuntimeStateChange={setRuntimeCompletionState}
              onSelectStep={(step) => void selectStep(step)}
              onSelectGithubRepository={(repository) => void selectGithubRepository(repository)}
              profileAnalyzing={profileAnalyzing}
              profileDraft={profileDraft}
              profileError={profileError}
              profileSaving={profileSaving}
              step={activeStep.id}
              updateProfileDraft={updateProfileDraft}
            />
          </div>
        </section>

        <SetupHealthSummary health={data.setupHealth} />
      </main>

      <footer className="sticky bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1180px] justify-end">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ui-button"
              disabled={!data.canManage || !canGoBack || isSaving}
              onClick={() => void goBack()}
            >
              {savingAction === "back" ? "Saving..." : "Back"}
            </button>
            {skipAllowed && !isCompleted ? (
              <button
                type="button"
                className="ui-button"
                disabled={!data.canManage || isSaving}
                onClick={() => void skipStep()}
              >
                {savingAction === "skip" ? "Saving..." : "Skip"}
              </button>
            ) : null}
            <button
              type="button"
              className="ui-button-primary"
              disabled={
                !data.canManage ||
                isCompleted ||
                isSaving ||
                githubContinueBlocked ||
                repositoryContinueBlocked ||
                runtimeCompletionBlocked ||
                verifyCompletionBlocked ||
                requiresInlineCompletion
              }
              onClick={() => void continueSetup()}
            >
              {isCompleted
                ? "Setup complete"
                : requiresInlineCompletion
                  ? "Complete in step"
                  : savingAction === "continue" || savingAction === "complete"
                    ? "Saving..."
                    : activeStep.id === "verify"
                      ? "Complete setup"
                      : "Continue"}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
