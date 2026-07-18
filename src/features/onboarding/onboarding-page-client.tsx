"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  AgentConfigFieldErrors,
  ApplyAgentConfigDefaultsResponse,
  BatchUpsertAgentConfigErrorResponse,
  BatchUpsertAgentConfigRequest,
  BatchUpsertAgentConfigResponse,
} from "@/app/api/agent-config/route";
import { AGENT_PROVIDER_SELECT_OPTIONS } from "@/components/shared/agent-provider-options";
import { PlusIcon, XIcon } from "@/components/shared/icons";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { SelectField, type SelectOption } from "@/components/ui/select";
import { Status, configurationStatusFromTone, type StatusValue } from "@/components/ui/status";
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
import { reduceOnboardingMutationData } from "@/features/onboarding/mutation-reducer";
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
  hasCurrentWallieSkills,
  RepositoryMetadata,
  RepositorySetupControls,
  RepositorySetupMessages,
  repositorySetupCanAdvance,
  RepositorySetupStatus,
} from "@/features/repositories/repository-setup-controls";
import type { FlashMessage } from "@/features/settings/settings-types";
import { codexCredentialTypeLabel } from "@/lib/codex/contracts";
import { upsertSecretPreview } from "@/features/settings/secret-previews";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingConflictResponse,
  WorkspaceOnboardingMutationAction,
  WorkspaceOnboardingMutationDelta,
  WorkspaceOnboardingMutationErrorResponse,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import {
  type AgentConfigKey,
  AGENT_CONFIG_LIMITS,
  ALLOWED_AGENT_CONFIG_KEYS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  STALL_TIMEOUT_MINUTE_LIMITS,
  getRecommendedAgentConfigDefault,
  normalizeAgentProviderName,
  stallTimeoutMinutesToMs,
} from "@/lib/agent-config/contracts";
import {
  type AgentConfigDrafts,
  agentConfigValueToDraft,
  applyAgentConfigDraftChange,
  parseAgentConfigDraft,
} from "@/lib/agent-config/drafts";
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
import type {
  VercelSandboxConnectionPreview,
  VercelSandboxConnectionResponse,
} from "@/lib/vercel-sandbox/contracts";
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

type PersistOnboardingAction = {
  action: WorkspaceOnboardingMutationAction;
  savingAction: string;
  step: WorkspaceOnboardingStep;
};

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

const railStateClasses: Record<OnboardingStepDisplayState, string> = {
  active: "bg-accent-soft text-accent",
  available: "text-muted hover:bg-control-hover hover:text-foreground",
  blocked: "text-muted opacity-55",
  completed: "text-muted hover:bg-control-hover hover:text-foreground",
  skipped: "text-muted hover:bg-control-hover hover:text-foreground",
};

const onboardingStepStatusValues = {
  active: "running",
  available: "queued",
  blocked: "blocked",
  completed: "complete",
  skipped: "skipped",
} satisfies Record<OnboardingStepDisplayState, StatusValue>;

function OnboardingStepStatus({ state }: { state: OnboardingStepDisplayState }) {
  return <Status compact value={onboardingStepStatusValues[state]} />;
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

function presenceBadge(configured: boolean) {
  return configured
    ? { tone: "success" as const, value: "Saved" }
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

function buildAgentConfigDrafts(agentConfig: AgentConfigMap): AgentConfigDrafts {
  return {
    agent_provider: agentConfigValueToDraft(
      "agent_provider",
      resolveAgentConfigValue("agent_provider", agentConfig),
    ),
    agent_model: agentConfigValueToDraft(
      "agent_model",
      resolveAgentConfigValue("agent_model", agentConfig),
    ),
    concurrency_limit: agentConfigValueToDraft(
      "concurrency_limit",
      resolveAgentConfigValue("concurrency_limit", agentConfig),
    ),
    stall_timeout_ms: agentConfigValueToDraft(
      "stall_timeout_ms",
      resolveAgentConfigValue("stall_timeout_ms", agentConfig),
    ),
    max_retries: agentConfigValueToDraft(
      "max_retries",
      resolveAgentConfigValue("max_retries", agentConfig),
    ),
  };
}

function draftValueToConfigMap(drafts: AgentConfigDrafts, fields: readonly FieldDescriptor[]) {
  const config: AgentConfigMap = {};
  for (const field of fields) {
    const draft = drafts[field.configKey].trim();
    if (field.type !== "number") {
      config[field.configKey] = draft;
      continue;
    }
    config[field.configKey] =
      field.configKey === "stall_timeout_ms"
        ? stallTimeoutMinutesToMs(Number(draft))
        : Number(draft);
  }
  return config;
}

export function isAgentConfigDraftDirty(
  configKey: AgentConfigKey,
  type: FieldType,
  draft: string,
  savedDraft: string,
): boolean {
  const validation = parseAgentConfigDraft(configKey, type, draft);
  if (!validation.ok) {
    return draft !== savedDraft;
  }
  return agentConfigValueToDraft(configKey, validation.value) !== savedDraft;
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
        accountEmail: status.accountEmail ?? null,
        checkedAt: status.checkedAt,
        connected: status.connected,
        credentialType: status.credentialType ?? null,
        expiresAt: status.expiresAt ?? null,
        reconnectReason: status.reconnectReason ?? null,
        reconnectRequired: status.reconnectRequired ?? false,
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
        checkedAt: status.checkedAt,
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

export function updateVercelSandboxConnectionInData(
  currentData: WorkspaceOnboardingData,
  connection: VercelSandboxConnectionPreview | null,
): WorkspaceOnboardingData {
  return {
    ...currentData,
    vercelSandboxConnection: connection,
    setupHealth: {
      ...currentData.setupHealth,
      vercelSandboxConnection: connection
        ? {
            connected: connection.status === "connected",
            lastValidationError: connection.lastValidationError,
            projectId: connection.projectId,
            projectName: connection.projectName,
            status: connection.status,
            teamId: connection.teamId,
            updatedAt: connection.updatedAt,
          }
        : {
            connected: false,
            lastValidationError: null,
            projectId: null,
            projectName: null,
            status: "missing",
            teamId: null,
            updatedAt: null,
          },
    },
  };
}

export function setupHealthItems(health: OnboardingSetupHealth): HealthSummaryItem[] {
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
  // Routing rows are seeded with workspace defaults, so `configured` is true even
  // before a Linear key exists. Only show the green "Saved" state once the key is
  // present; otherwise surface the default routes as a neutral "Defaults" badge so a
  // fresh workspace never reads as configured.
  const linearRouting = !health.linearRouting.configured
    ? { tone: "warning" as const, value: "Missing" }
    : health.linearKey.configured
      ? { tone: "success" as const, value: "Saved" }
      : { tone: "neutral" as const, value: "Defaults" };
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
  const vercelSandbox = health.vercelSandboxConnection.connected
    ? {
        detail:
          health.vercelSandboxConnection.projectName ??
          health.vercelSandboxConnection.projectId ??
          "Vercel project connected",
        tone: "success" as const,
        value: "Connected",
      }
    : health.vercelSandboxConnection.status === "error"
      ? {
          detail:
            health.vercelSandboxConnection.lastValidationError ?? "Connection needs attention",
          tone: "danger" as const,
          value: "Error",
        }
      : {
          detail: "Vercel project required",
          tone: "warning" as const,
          value: "Missing",
        };
  const sandbox = health.latestSandboxCapabilityCheck
    ? !health.vercelSandboxConnection.connected
      ? { tone: "warning" as const, value: "Blocked" }
      : health.latestSandboxCapabilityCheck.status === "success"
        ? { tone: "success" as const, value: "Ready" }
        : health.latestSandboxCapabilityCheck.status === "running"
          ? { tone: "accent" as const, value: "Running" }
          : { tone: "danger" as const, value: "Error" }
    : { tone: "neutral" as const, value: "No check" };
  const sandboxDetail = !health.vercelSandboxConnection.connected
    ? "Connect Vercel first"
    : health.latestSandboxCapabilityCheck
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
      detail: !health.linearRouting.configured
        ? "Routing not mapped"
        : health.linearKey.configured
          ? "Routes saved"
          : "Default routes — add a Linear key",
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
      detail: vercelSandbox.detail,
      label: "Vercel",
      tone: vercelSandbox.tone,
      value: vercelSandbox.value,
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
    description: `Stall timeout in minutes (${STALL_TIMEOUT_MINUTE_LIMITS.min}-${STALL_TIMEOUT_MINUTE_LIMITS.max}).`,
    label: "Stall timeout (minutes)",
    placeholder: agentConfigValueToDraft(
      "stall_timeout_ms",
      RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms,
    ),
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
          className="flex items-start justify-between gap-3 rounded-[6px] border border-border bg-sheet px-3 py-2"
          key={requirement.id}
        >
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">{requirement.label}</p>
            <p className="mt-0.5 text-xs leading-5 text-muted">{requirement.detail}</p>
          </div>
          <Status
            label={requirement.passed ? "Ready" : "Blocked"}
            value={requirement.passed ? "healthy" : "blocked"}
          />
        </div>
      ))}
    </div>
  );
}

export function OnboardingVercelSandboxPanel({
  canManage,
  connection,
  disabled,
  onConnectionChange,
  workspaceId,
}: {
  canManage: boolean;
  connection: VercelSandboxConnectionPreview | null;
  disabled: boolean;
  onConnectionChange: (connection: VercelSandboxConnectionPreview | null) => void;
  workspaceId: string;
}) {
  const [token, setToken] = useState("");
  const [teamId, setTeamId] = useState(connection?.teamId ?? "");
  const [projectId, setProjectId] = useState(connection?.projectId ?? "");
  const [busyAction, setBusyAction] = useState<"disconnect" | "save" | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busy = disabled || busyAction !== null;
  const connected = connection?.status === "connected";
  const statusTone: HealthTone = !connection ? "warning" : connected ? "success" : "danger";
  const statusLabel = !connection ? "Missing" : connected ? "Connected" : "Needs attention";

  async function handleSave() {
    if (!canManage || busy) return;
    if (!token.trim() || !teamId.trim() || !projectId.trim()) {
      setMessage(null);
      setError("Enter a Vercel token, team id, and project id.");
      return;
    }
    setBusyAction("save");
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/vercel-sandbox-connection`, {
        body: JSON.stringify({
          projectId: projectId.trim(),
          teamId: teamId.trim(),
          token: token.trim(),
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const body = (await response.json().catch(() => null)) as
        | (VercelSandboxConnectionResponse & { error?: string })
        | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? "Vercel Sandbox connection failed.");
      }
      onConnectionChange(body.connection);
      setToken("");
      setMessage("Vercel Sandbox connection saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Vercel Sandbox connection failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDisconnect() {
    if (!canManage || busy) return;
    setBusyAction("disconnect");
    setDisconnectError(null);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/vercel-sandbox-connection`, {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => null)) as
        | (VercelSandboxConnectionResponse & { error?: string })
        | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? "Vercel Sandbox disconnect failed.");
      }
      setDisconnectOpen(false);
      onConnectionChange(body.connection);
      setMessage("Vercel Sandbox disconnected.");
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Vercel Sandbox disconnect failed.";
      setDisconnectError(message);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="rounded-[6px] border border-border bg-sheet p-4" id="onboarding-vercel">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-foreground">Vercel Sandbox</h3>
          <p className="mt-1 text-xs leading-5 text-muted">
            Wallie runs every session inside this workspace&apos;s Vercel project. Connect it here
            so sessions can run — the token is encrypted and never returned to the browser.
          </p>
        </div>
        <Status label={statusLabel} value={configurationStatusFromTone(statusTone)} />
      </div>

      {error ? (
        <div
          className="mt-4 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
          role="alert"
        >
          {error}
        </div>
      ) : null}
      {message ? (
        <div
          className="mt-4 rounded-[6px] border border-success/20 bg-success-soft px-3 py-2 text-[13px] text-success"
          role="status"
        >
          {message}
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-1">
        {connection ? (
          <p className="text-xs leading-5 text-muted">
            {connection.projectName ?? connection.projectId} on {connection.teamId}
            {connection.tokenPreview ? ` · ${connection.tokenPreview}` : ""}
          </p>
        ) : (
          <p className="text-xs leading-5 text-muted">
            Connect a Vercel project before running Wallie sessions.
          </p>
        )}
        {connection?.lastValidationError ? (
          <p className="text-xs leading-5 text-danger">{connection.lastValidationError}</p>
        ) : null}
      </div>

      {canManage ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5 sm:col-span-2">
              <span className="text-xs font-medium text-muted">Vercel token</span>
              <input
                autoComplete="off"
                className="ui-input"
                disabled={busy}
                onChange={(event) => setToken(event.target.value)}
                placeholder="vca_…"
                spellCheck={false}
                type="password"
                value={token}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted">Team id</span>
              <input
                autoComplete="off"
                className="ui-input"
                disabled={busy}
                onChange={(event) => setTeamId(event.target.value)}
                placeholder="team_…"
                spellCheck={false}
                value={teamId}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted">Project id</span>
              <input
                autoComplete="off"
                className="ui-input"
                disabled={busy}
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="prj_…"
                spellCheck={false}
                value={projectId}
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {connection ? (
              <DestructiveConfirmationDialog
                actionLabel="Disconnect Vercel Sandbox"
                description={`Disconnecting ${connection.projectName ?? connection.projectId} prevents this workspace from starting new sandbox runs until another Vercel connection is saved.`}
                errorMessage={disconnectError}
                onConfirm={() => void handleDisconnect()}
                onOpenChange={(open) => {
                  setDisconnectOpen(open);
                  setDisconnectError(null);
                }}
                open={disconnectOpen}
                pending={busyAction === "disconnect"}
                pendingLabel="Disconnecting…"
                title={`Disconnect ${connection.projectName ?? connection.projectId}?`}
                trigger={
                  <button
                    aria-label="Disconnect Vercel Sandbox"
                    className="ui-button-danger"
                    disabled={busy}
                    type="button"
                  >
                    Disconnect
                  </button>
                }
              />
            ) : null}
            <button
              className="ui-button-primary"
              disabled={busy}
              onClick={() => void handleSave()}
              type="button"
            >
              {busyAction === "save" ? "Validating…" : "Save Vercel connection"}
            </button>
          </div>
        </>
      ) : (
        <p className="mt-4 text-[13px] leading-6 text-muted">
          Workspace admins can connect the Vercel Sandbox project used for Wallie runs.
        </p>
      )}
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
  const [serverFieldErrors, setServerFieldErrors] = useState<AgentConfigFieldErrors>({});
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
  const handleVercelConnectionChange = useCallback(
    (connection: VercelSandboxConnectionPreview | null) =>
      onDataChange((current) => updateVercelSandboxConnectionInData(current, connection)),
    [onDataChange],
  );
  const fields = AGENT_CONFIG_FIELDS;
  const savedDrafts = buildAgentConfigDrafts(data.agentConfig);
  const fieldStatuses = fields.map((field) => {
    const draft = drafts[field.configKey];
    const validation = parseAgentConfigDraft(field.configKey, field.type, draft);
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
      validationError: validation.ok
        ? (serverFieldErrors[field.configKey] ?? null)
        : validation.error,
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
    agentConfigValueToDraft(key, getRecommendedAgentConfigDefault(key, defaultsProvider));
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
    setServerFieldErrors((current) => {
      if (!current[key]) return current;
      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  }

  async function handleSaveConfig() {
    if (!canSaveConfig) return;
    setBusyAction("config");
    setRuntimeError(null);
    setRuntimeMessage(null);
    setServerFieldErrors({});

    try {
      const config: BatchUpsertAgentConfigRequest["config"] = {};
      for (const status of fieldStatuses) {
        if (!status.isDirty || !status.validation.ok) continue;
        config[status.field.configKey] = status.validation.value;
      }

      const response = await fetch("/api/agent-config", {
        body: JSON.stringify({
          config,
          workspaceId: data.workspace.id,
        } satisfies BatchUpsertAgentConfigRequest),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | BatchUpsertAgentConfigErrorResponse
        | BatchUpsertAgentConfigResponse
        | null;
      if (!response.ok || !body || !("entries" in body)) {
        if (body && "fieldErrors" in body) {
          setServerFieldErrors(body.fieldErrors ?? {});
        }
        throw new Error(body && "error" in body ? body.error : "Agent config save failed.");
      }

      const nextData = updateAgentConfigInData(data, body.entries);
      setDrafts((current) => {
        const next = { ...current };
        for (const entry of body.entries) {
          if (!ALLOWED_AGENT_CONFIG_KEYS.includes(entry.key as AgentConfigKey)) continue;
          const key = entry.key as AgentConfigKey;
          next[key] = agentConfigValueToDraft(key, entry.value);
        }
        return next;
      });
      onDataChange(nextData);
      setRuntimeMessage("Saved.");
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

      <div className="rounded-[6px] border border-border bg-sheet p-4">
        <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Agent config</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              Unset fields use Wallie&apos;s recommended defaults until saved.
            </p>
          </div>
          <button
            className="ui-button"
            disabled={!canApplyDefaults}
            onClick={() => void handleApplyDefaults()}
            type="button"
          >
            {busyAction === "defaults" ? "Applying…" : "Apply recommended defaults"}
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
                  <span className="text-xs font-medium text-muted">{status.field.label}</span>
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
                <p className="text-xs leading-5 text-danger" role="alert">
                  {status.validationError}
                </p>
              ) : (
                <p className="text-xs leading-5 text-muted">{status.field.description}</p>
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
                  <span className="text-xs font-medium text-muted">{status.field.label}</span>
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
                <p className="text-xs leading-5 text-danger" role="alert">
                  {status.validationError}
                </p>
              ) : (
                <p className="text-xs leading-5 text-muted">{status.field.description}</p>
              )}
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="min-w-0 text-xs leading-5 text-muted">
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
              {busyAction === "config" ? "Saving…" : "Save config"}
            </button>
          </div>
        </div>

        <div className="mt-4">
          <ProviderAccessPanel
            initialClaudeCodeStatus={{
              checkedAt: data.setupHealth.claudeCodeConnection.checkedAt,
              connected: data.setupHealth.claudeCodeConnection.connected,
              updatedAt: data.setupHealth.claudeCodeConnection.updatedAt,
            }}
            initialCodexStatus={{
              accountEmail: data.setupHealth.codexConnection.accountEmail,
              checkedAt: data.setupHealth.codexConnection.checkedAt,
              connected: data.setupHealth.codexConnection.connected,
              credentialType: data.setupHealth.codexConnection.credentialType,
              expired: data.setupHealth.codexConnection.status === "expired",
              expiresAt: data.setupHealth.codexConnection.expiresAt,
              reconnectReason: data.setupHealth.codexConnection.reconnectReason,
              reconnectRequired: data.setupHealth.codexConnection.reconnectRequired,
              updatedAt: data.setupHealth.codexConnection.updatedAt,
            }}
            onClaudeCodeStatusChange={handleClaudeCodeStatusChange}
            onCodexStatusChange={handleCodexStatusChange}
            provider={selectedProvider}
            returnTo={`/w/${data.workspace.slug}/onboarding?step=runtime`}
            vercelConnectionHref="#onboarding-vercel"
            vercelSandboxConnection={data.vercelSandboxConnection}
            variant="embedded"
            workspaceId={data.workspace.id}
          />
        </div>
      </div>

      <OnboardingVercelSandboxPanel
        canManage={data.canManage}
        connection={data.vercelSandboxConnection}
        disabled={isSaving}
        onConnectionChange={handleVercelConnectionChange}
        workspaceId={data.workspace.id}
      />

      <div className="space-y-4">
        <div className="rounded-[6px] border border-border bg-sheet">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-[14px] font-semibold text-foreground">
              Repository environment variables
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted">
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
                      <Status
                        label={secret ? secretPreviewLabel(secret) : "Not set"}
                        value={secret ? "healthy" : "not_started"}
                      />
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
                <span className="text-xs text-muted">Finish each added row before saving.</span>
              ) : null}
              <button
                className="ui-button-primary"
                disabled={!canSaveRepositoryConfig}
                onClick={() => void handleSaveRepositoryConfig()}
                type="button"
              >
                {busyAction === "repository-config" ? "Saving…" : "Save config"}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-[6px] border border-border bg-sheet p-4">
        <div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Runtime readiness</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
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

function sandboxStatusValue(check: SandboxCapabilityCheckState | null): StatusValue {
  if (!check) return "not_started";
  const values = {
    error: "blocked",
    running: "running",
    success: "healthy",
  } satisfies Record<SandboxCapabilityCheckState["status"], StatusValue>;
  return values[check.status];
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

      <div className="rounded-[6px] border border-border bg-sheet p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Readiness checklist</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              Resolve blockers in their owning setup step, then complete onboarding.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-2">
          {checklist.map((item) => (
            <div
              className="flex flex-col gap-3 rounded-[6px] border border-border bg-sheet px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
              key={item.id}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">{item.label}</p>
                <p className="mt-0.5 text-xs leading-5 text-muted">{item.detail}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Status
                  label={item.statusLabel ?? (item.passed ? "Ready" : "Blocked")}
                  value={configurationStatusFromTone(
                    item.statusTone ?? (item.passed ? "success" : "warning"),
                  )}
                />
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

      <div className="rounded-[6px] border border-border bg-sheet p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Sandbox capability</h3>
            <p className="mt-1 text-xs leading-5 text-muted">
              Checks run against the selected repository.
            </p>
          </div>
          <Status label={check ? undefined : "No check"} value={sandboxStatusValue(check)} />
        </div>
        {check?.errorText ? (
          <p className="mt-3 text-xs leading-5 text-danger">{check.errorText}</p>
        ) : null}
        {check ? (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {Object.entries(check.capabilities).map(([name, result]) => {
              const value: StatusValue = result?.ok ? "healthy" : "blocked";
              return (
                <div className="rounded-[6px] border border-border px-3 py-2" key={name}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-foreground">{name}</p>
                    <Status compact value={value} />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {result?.detail ?? "No detail recorded."}
                  </p>
                </div>
              );
            })}
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
              ? "Starting…"
              : isPolling
                ? "Checking…"
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
      <div className="rounded-[6px] border border-border bg-sheet p-4">
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
    <ul className="divide-y divide-border rounded-[6px] border border-border bg-sheet">
      {repositories.map((repository) => {
        const selected = selectedRepository?.id === repository.id;
        const showProfileEditor = selected && Boolean(profileDraft);
        const rowProfileBusy = selected && (profileAnalyzing || profileSaving);
        const showSetupControls =
          Boolean(repository.onboarding.setupPrUrl) ||
          repository.onboarding.status !== "ready" ||
          !hasCurrentWallieSkills(repository.onboarding);
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
                {selected ? <Status label="Selected" value="approved" /> : null}
                <RepositorySetupStatus status={repository.onboarding.status} />
              </div>
              <RepositoryMetadata repository={repository} />
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
              <div className="rounded-[6px] border border-border bg-sheet px-3 py-2 text-[13px] text-muted">
                Analyzing repository…
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
  onPipelineCompleted,
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
  onPipelineCompleted: (
    action: string,
    pipeline: NonNullable<WorkspaceOnboardingData["pipeline"]>,
  ) => Promise<void>;
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
        onCompleted={onPipelineCompleted}
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
      <div className="rounded-[6px] border border-border bg-sheet p-4">
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
            <OnboardingStepStatus state={step.displayState} />
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
  const buttonRefs = useRef(new Map<WorkspaceOnboardingStep, HTMLButtonElement>());
  const activeStepId = items.find((step) => step.displayState === "active")?.id ?? null;

  useEffect(() => {
    if (!activeStepId) {
      return;
    }

    buttonRefs.current.get(activeStepId)?.scrollIntoView({
      block: "nearest",
      inline: "center",
    });
  }, [activeStepId]);

  return (
    <div className="border-y border-border bg-sheet px-4 py-2 lg:hidden">
      <div className="flex snap-x gap-2 overflow-x-auto scroll-px-4 pb-1" aria-label="Setup steps">
        {items.map((step) => (
          <button
            ref={(node) => {
              if (node) {
                buttonRefs.current.set(step.id, node);
              } else {
                buttonRefs.current.delete(step.id);
              }
            }}
            key={step.id}
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "inline-flex h-9 min-w-[112px] snap-start items-center justify-center gap-1.5 rounded-[6px] border border-transparent px-2 text-xs font-medium",
              railStateClasses[step.displayState],
              (!canSelect || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canSelect || !step.isNavigable}
            onClick={() => onSelect(step.id)}
          >
            <OnboardingStepStatus state={step.displayState} />
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
              <p className="text-xs font-medium text-foreground">{item.label}</p>
              <p className="mt-0.5 truncate type-annotation text-muted">{item.detail}</p>
            </div>
            <Status
              label={item.value}
              value={item.value === "Running" ? "running" : configurationStatusFromTone(item.tone)}
            />
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
  latestSandboxCapabilityCheck: SandboxCapabilityCheckState | null,
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
      {
        ...currentData.setupHealth,
        latestSandboxCapabilityCheck,
      },
      nextGithub,
      currentData.onboarding.selectedGithubRepositoryId,
    ),
  };
}

export function applySavedPipelineToData(
  currentData: WorkspaceOnboardingData,
  pipeline: NonNullable<WorkspaceOnboardingData["pipeline"]>,
): WorkspaceOnboardingData {
  return {
    ...currentData,
    pipeline,
    setupHealth: {
      ...currentData.setupHealth,
      defaultPipeline: {
        configured: pipeline.stages.length > 0,
        pipelineId: pipeline.id,
        stageCount: pipeline.stages.length,
        status: pipeline.stages.length > 0 ? "ready" : "missing",
      },
    },
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
  const inlineCompletionLabel =
    activeStep.id === "linear" ? "Finish Linear setup to continue" : "Save pipeline to continue";
  const githubContinueBlocked = activeStep.id === "github" && !canCompleteGitHubSetupStep(data);
  const repositoryContinueBlocked =
    activeStep.id === "repository" && !canCompleteRepositoryStep(data);
  const runtimeCompletionBlocked =
    activeStep.id === "runtime" &&
    !activeStepAlreadyResolved &&
    (!runtimeCompletionState.readiness.canComplete ||
      runtimeCompletionState.hasInvalidDrafts ||
      runtimeCompletionState.hasUnsavedDrafts ||
      !data.setupHealth.vercelSandboxConnection.connected);
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

  async function persistOnboarding(
    changes: WorkspaceOnboardingUpdatePayload,
    mutation: PersistOnboardingAction,
  ) {
    if (!data.canManage || saveInFlightRef.current) return null;

    saveInFlightRef.current = true;
    setSavingAction(mutation.savingAction);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding`, {
        body: JSON.stringify({
          action: mutation.action,
          changes,
          expectedUpdatedAt: latestDataRef.current.onboarding.updatedAt,
          step: mutation.step,
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });

      const body = (await response.json().catch(() => null)) as
        | WorkspaceOnboardingConflictResponse
        | WorkspaceOnboardingMutationDelta
        | WorkspaceOnboardingMutationErrorResponse
        | null;

      if (body?.kind === "onboarding-conflict") {
        const nextData = reduceOnboardingMutationData(latestDataRef.current, body);
        latestDataRef.current = nextData;
        setData(nextData);
        throw new Error(body.error);
      }

      if (!response.ok || body?.kind !== "onboarding-mutation") {
        const message = body && "error" in body ? body.error : "Failed to save onboarding state.";
        throw new Error(message);
      }

      const nextData = reduceOnboardingMutationData(latestDataRef.current, body);
      latestDataRef.current = nextData;
      setData(nextData);
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

    const nextData = await persistOnboarding(patch, {
      action: "step-complete",
      savingAction: action,
      step: latestDataRef.current.onboarding.currentStep,
    });
    if (!nextData) {
      throw new Error("Failed to save onboarding state.");
    }
  }

  async function completePipelineStep(
    action: string,
    pipeline: NonNullable<WorkspaceOnboardingData["pipeline"]>,
  ) {
    const nextData = applySavedPipelineToData(latestDataRef.current, pipeline);
    latestDataRef.current = nextData;
    setData(nextData);
    await completeCurrentStep(action);
  }

  async function continueSetup() {
    if (activeStep.id === "verify") {
      await completeOnboarding();
      return;
    }

    if (inlineCompletionUnavailable) {
      const patch = buildOnboardingAdvancePatch(onboarding);
      if (!patch) return;
      await persistOnboarding(patch, {
        action: "continue",
        savingAction: "continue",
        step: onboarding.currentStep,
      });
      return;
    }

    await persistOnboarding(buildOnboardingContinuePatch(onboarding), {
      action: "continue",
      savingAction: "continue",
      step: onboarding.currentStep,
    });
  }

  async function completeOnboarding() {
    if (!data.canManage || saveInFlightRef.current || verifyCompletionBlocked) return;

    saveInFlightRef.current = true;
    setSavingAction("complete");
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding/complete`, {
        body: JSON.stringify({ expectedUpdatedAt: latestDataRef.current.onboarding.updatedAt }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | (WorkspaceOnboardingMutationErrorResponse & {
            blockers?: ReturnType<typeof verifyBlockersFromChecklist>;
          })
        | WorkspaceOnboardingConflictResponse
        | WorkspaceOnboardingMutationDelta
        | null;

      if (body?.kind === "onboarding-conflict") {
        const nextData = reduceOnboardingMutationData(latestDataRef.current, body);
        latestDataRef.current = nextData;
        setData(nextData);
        throw new Error(body.error);
      }

      if (!response.ok || body?.kind !== "onboarding-mutation") {
        const blockerText =
          body && "blockers" in body && body.blockers?.length
            ? ` Blocked: ${body.blockers.map((blocker) => blocker.label).join(", ")}.`
            : "";
        const message = body && "error" in body ? body.error : "Failed to complete onboarding.";
        throw new Error(message + blockerText);
      }

      const nextData = reduceOnboardingMutationData(latestDataRef.current, body);
      latestDataRef.current = nextData;
      setData(nextData);
      router.push(workspaceBasePath(data.workspace.slug));
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
    await persistOnboarding(patch, {
      action: "skip",
      savingAction: "skip",
      step: onboarding.currentStep,
    });
  }

  async function goBack() {
    const previousStep = ONBOARDING_STEPS[onboardingStepIndex(onboarding.currentStep) - 1]?.id;
    if (!previousStep) return;
    const patch = buildOnboardingRailNavigationPatch(onboarding, previousStep);
    if (!patch) return;
    await persistOnboarding(patch, {
      action: "navigate",
      savingAction: "back",
      step: previousStep,
    });
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
    await persistOnboarding(patch, {
      action: "navigate",
      savingAction: `rail:${step}`,
      step,
    });
  }

  async function exitSetup() {
    const patch = data.canManage ? buildOnboardingExitPatch(onboarding) : null;
    const nextData = patch
      ? await persistOnboarding(patch, {
          action: "exit",
          savingAction: "exit",
          step: onboarding.currentStep,
        })
      : data;
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

    const nextData = await persistOnboarding(patch, {
      action: "repository-selection",
      savingAction: "repository-selection",
      step: "repository",
    });
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

      const body = (await response.json()) as {
        latestSandboxCapabilityCheck: SandboxCapabilityCheckState | null;
        profile: EditableProfile;
      };
      const nextData = applySavedRepositoryProfileToData(
        latestDataRef.current,
        body.profile,
        body.latestSandboxCapabilityCheck,
      );
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
        await persistOnboarding(completionPatch, {
          action: "step-complete",
          savingAction: "repository-profile",
          step: "repository",
        });
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
    <div className="flex min-h-[100svh] flex-col bg-sheet text-foreground">
      <header className="mx-auto flex w-full max-w-[1180px] flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 pb-8 pt-8 sm:px-8 sm:pt-10">
        <div className="min-w-0 space-y-2">
          <h1 className="type-page-title">Set up {data.workspace.name}</h1>
          <p className="max-w-2xl text-[14px] leading-6 text-muted">
            Finish the required connections before starting sessions.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!data.canManage ? <Status label="Read only" value="not_started" /> : null}
          <button
            type="button"
            className="ui-button"
            disabled={isSaving}
            onClick={() => void exitSetup()}
          >
            {savingAction === "exit" ? "Exiting…" : "Exit setup"}
          </button>
        </div>
      </header>

      <MobileStepControl canSelect={!isSaving} items={railItems} onSelect={selectStep} />

      <main
        id="main-content"
        className="mx-auto grid w-full max-w-[1180px] flex-1 grid-cols-1 gap-10 px-4 pb-28 sm:px-8 lg:grid-cols-[180px_minmax(0,1fr)_260px] lg:gap-12"
      >
        <aside className="hidden lg:block">
          <div className="sticky top-8">
            <StepRail canSelect={!isSaving} items={railItems} onSelect={selectStep} />
          </div>
        </aside>

        <section className="min-w-0">
          <div className="settings-section-header mb-6">
            <div className="min-w-0">
              <h2 className="type-section-title">{activeStep.title}</h2>
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
              onPipelineCompleted={completePipelineStep}
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

      <footer className="sticky bottom-0 z-20 border-t border-border bg-sheet/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1180px] justify-end">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ui-button"
              disabled={!data.canManage || !canGoBack || isSaving}
              onClick={() => void goBack()}
            >
              {savingAction === "back" ? "Saving…" : "Back"}
            </button>
            {skipAllowed && !isCompleted ? (
              <button
                type="button"
                className="ui-button"
                disabled={!data.canManage || isSaving}
                onClick={() => void skipStep()}
              >
                {savingAction === "skip" ? "Saving…" : "Skip"}
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
                  ? inlineCompletionLabel
                  : savingAction === "continue" || savingAction === "complete"
                    ? "Saving…"
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
