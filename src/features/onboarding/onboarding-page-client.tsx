"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  ApplyAgentConfigDefaultsResponse,
  UpsertAgentConfigResponse,
} from "@/app/api/agent-config/route";
import type { VerifyAgentConfigResponse } from "@/app/api/agent-config/verify/route";
import { GitHubConnectionPanel } from "@/features/github/github-connection-panel";
import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import {
  buildOnboardingAdvancePatch,
  buildOnboardingContinuePatch,
  buildOnboardingExitPatch,
  buildOnboardingRailNavigationPatch,
  buildOnboardingSkipPatch,
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
import { CodexConnectionPanel } from "@/features/settings/codex-connection-panel";
import { upsertSecretPreview } from "@/features/settings/secret-previews";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import {
  type AgentConfigKey,
  AGENT_CONFIG_LIMITS,
  AGENT_PROVIDERS,
  ALLOWED_AGENT_CONFIG_KEYS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  parseAgentConfigValue,
} from "@/lib/agent-config/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import type {
  SandboxCapabilityCheckLatestResponse,
  SandboxCapabilityCheckResponse,
  SandboxCapabilityCheckState,
} from "@/lib/sandbox-capabilities/contracts";
import type { UpsertWorkspaceSecretResponse } from "@/lib/secrets/contracts";
import { workspaceBasePath, workspaceSettingsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type OnboardingPageClientProps = {
  initialData: WorkspaceOnboardingData;
};

type HealthTone = "accent" | "danger" | "neutral" | "success" | "warning";

type HealthSummaryItem = {
  detail: string;
  label: string;
  tone: HealthTone;
  value: string;
};

type StepHealthItem = {
  label: string;
  tone: HealthTone;
  value: string;
};

type EditableProfile = RepositoryProfileState;
type AgentConfigDrafts = Record<AgentConfigKey, string>;
type FieldType = "number" | "select" | "text";

type RuntimeCompletionState = {
  hasInvalidDrafts: boolean;
  hasUnsavedDrafts: boolean;
  readiness: RuntimeReadiness;
};

type FieldDescriptor = {
  configKey: AgentConfigKey;
  description: string;
  label: string;
  options?: readonly string[];
  placeholder?: string;
  type: FieldType;
};

const stepStateLabels: Record<OnboardingStepDisplayState, string> = {
  active: "Current",
  available: "Available",
  blocked: "Blocked",
  completed: "Complete",
  skipped: "Skipped",
};

const badgeToneClasses: Record<HealthTone, string> = {
  accent: "ui-badge-neutral",
  danger: "ui-badge-danger",
  neutral: "ui-badge-neutral",
  success: "ui-badge-neutral",
  warning: "ui-badge-neutral",
};

const railStateClasses: Record<OnboardingStepDisplayState, string> = {
  active: "border-border-strong bg-background text-foreground shadow-sm",
  available: "border-border bg-surface text-foreground hover:bg-surface-strong",
  blocked: "border-border bg-surface-muted text-muted opacity-70",
  completed: "border-border bg-surface text-muted hover:bg-surface-strong",
  skipped: "border-border bg-surface text-muted hover:bg-surface-strong",
};

function StepStateIcon({ state }: { state: OnboardingStepDisplayState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-2 w-2 rounded-full",
        state === "active" ? "bg-foreground" : "bg-muted/60",
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

function presenceBadge(configured: boolean) {
  return configured
    ? { tone: "success" as const, value: "Present" }
    : { tone: "warning" as const, value: "Missing" };
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

function workspaceSecretKeys(data: WorkspaceOnboardingData) {
  return data.setupHealth.workspaceSecrets.configuredKeys;
}

function runtimeReadinessFromData(data: WorkspaceOnboardingData, agentConfig = data.agentConfig) {
  return buildRuntimeReadiness({
    agentConfig,
    codexConnection: data.setupHealth.codexConnection,
    primaryRepositoryId: data.setupHealth.primaryRepositoryProfile.repositoryId,
    repositorySetup: data.setupHealth.repositorySetup,
    secretKeys: workspaceSecretKeys(data),
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
  const codex = health.codexConnection.connected
    ? { tone: "success" as const, value: "Connected" }
    : health.codexConnection.status === "expired"
      ? { tone: "danger" as const, value: "Expired" }
      : { tone: "warning" as const, value: "Missing" };
  const sandbox = health.latestSandboxCapabilityCheck
    ? health.latestSandboxCapabilityCheck.status === "success"
      ? { tone: "success" as const, value: "Ready" }
      : health.latestSandboxCapabilityCheck.status === "running"
        ? { tone: "accent" as const, value: "Running" }
        : { tone: "danger" as const, value: "Error" }
    : { tone: "neutral" as const, value: "No check" };

  return [
    { detail: github.detail, label: "GitHub", tone: github.tone, value: github.value },
    {
      detail: health.primaryRepositoryProfile.fullName ?? "No primary repository",
      label: "Repository",
      tone: health.primaryRepositoryProfile.configured ? "success" : "warning",
      value: health.primaryRepositoryProfile.configured ? "Selected" : "Missing",
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
      detail: health.codexConnection.updatedAt ? "Token available" : "Account connection required",
      label: "Codex",
      tone: codex.tone,
      value: codex.value,
    },
    {
      detail: health.latestSandboxCapabilityCheck?.checkedAt ?? "Run a capability check",
      label: "Sandbox",
      tone: sandbox.tone,
      value: sandbox.value,
    },
  ];
}

function stepHealthItems(
  step: WorkspaceOnboardingStep,
  health: OnboardingSetupHealth,
): StepHealthItem[] {
  switch (step) {
    case "github":
      return [
        {
          label: "Installation",
          tone: health.githubInstallation.connected ? "success" : "warning",
          value: health.githubInstallation.connected ? "Connected" : "Missing",
        },
        {
          label: "Target",
          tone: health.githubInstallation.targetName ? "success" : "neutral",
          value: health.githubInstallation.targetName ?? "Not selected",
        },
      ];
    case "repository":
      return [
        {
          label: "Repository setup",
          tone:
            health.repositorySetup.status === "ready"
              ? "success"
              : health.repositorySetup.status === "error"
                ? "danger"
                : health.repositorySetup.status === "conflict"
                  ? "warning"
                  : "neutral",
          value: health.repositorySetup.status,
        },
        {
          label: "Primary profile",
          tone: health.primaryRepositoryProfile.configured ? "success" : "warning",
          value: health.primaryRepositoryProfile.configured ? "Saved" : "Missing",
        },
      ];
    case "pipeline":
      return [
        {
          label: "Default pipeline",
          tone: health.defaultPipeline.configured ? "success" : "warning",
          value: health.defaultPipeline.configured ? "Ready" : "Missing",
        },
        {
          label: "Stages",
          tone: health.defaultPipeline.stageCount > 0 ? "success" : "warning",
          value: String(health.defaultPipeline.stageCount),
        },
      ];
    case "linear":
      return [
        {
          label: "Linear key",
          tone: health.linearKey.configured ? "success" : "warning",
          value: health.linearKey.configured ? "Present" : "Missing",
        },
        {
          label: "Routing",
          tone: health.linearRouting.configured ? "success" : "warning",
          value: health.linearRouting.configured ? "Mapped" : "Missing",
        },
      ];
    case "runtime":
      return [
        {
          label: "Agent config",
          tone: health.agentConfig.configured ? "success" : "warning",
          value: health.agentConfig.configured ? "Present" : "Missing",
        },
        {
          label: "Codex",
          tone: health.codexConnection.connected ? "success" : "warning",
          value: health.codexConnection.connected ? "Connected" : "Missing",
        },
        {
          label: "Sandbox",
          tone:
            health.latestSandboxCapabilityCheck?.status === "success"
              ? "success"
              : health.latestSandboxCapabilityCheck?.status === "error"
                ? "danger"
                : "neutral",
          value: health.latestSandboxCapabilityCheck?.status ?? "No check",
        },
      ];
    case "verify":
      return setupHealthItems(health).map((item) => ({
        label: item.label,
        tone: item.tone,
        value: item.value,
      }));
  }
}

function settingsHref(workspaceSlug: string, anchor: string) {
  return `${workspaceSettingsPath(workspaceSlug)}#${anchor}`;
}

const AGENT_CONFIG_FIELDS: FieldDescriptor[] = [
  {
    configKey: "agent_provider",
    description: "Choose the runtime Wallie uses for coding-agent work.",
    label: "Agent provider",
    options: AGENT_PROVIDERS,
    type: "select",
  },
  {
    configKey: "agent_model",
    description: "Use Verify to check the model against the selected provider.",
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

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function joinList(value: readonly string[]) {
  return value.join("\n");
}

function applyGithubHealth(
  health: OnboardingSetupHealth,
  github: WorkspaceGitHubData,
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
    ...buildRepositorySetupHealth(github),
  };
}

function ProfileField({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <input
        className="ui-input w-full"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

function RepositoryProfileEditor({
  canManage,
  isBusy,
  isDirty,
  onChange,
  onInfer,
  onSave,
  profile,
}: {
  canManage: boolean;
  isBusy: boolean;
  isDirty: boolean;
  onChange: (profile: EditableProfile, dirty?: boolean) => void;
  onInfer: () => void;
  onSave: () => void;
  profile: EditableProfile;
}) {
  const confidence = isDirty ? "manual" : profile.inferenceConfidence;

  function update<K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) {
    onChange({ ...profile, [key]: value, inferenceConfidence: "manual" }, true);
  }

  return (
    <div className="rounded-[6px] border border-border bg-background p-4">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-foreground">Repository profile</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge
              tone={
                confidence === "high" ? "success" : confidence === "low" ? "warning" : "neutral"
              }
            >
              {confidence}
            </Badge>
            {profile.packageManager ? (
              <span className="ui-pill">{profile.packageManager}</span>
            ) : null}
            {profile.languageHints.map((hint) => (
              <span className="ui-pill" key={hint}>
                {hint}
              </span>
            ))}
            {profile.frameworkHints.map((hint) => (
              <span className="ui-pill" key={hint}>
                {hint}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            className="ui-button"
            disabled={!canManage || isBusy}
            onClick={onInfer}
            type="button"
          >
            {isBusy ? "Inferring..." : "Refresh inference"}
          </button>
          <button
            className="ui-button-primary"
            disabled={!canManage || isBusy}
            onClick={onSave}
            type="button"
          >
            {isBusy ? "Saving..." : "Save profile"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProfileField
          label="Package manager"
          onChange={(value) => update("packageManager", value.trim() || null)}
          placeholder="pnpm"
          value={profile.packageManager ?? ""}
        />
        <ProfileField
          label="Install command"
          onChange={(value) => update("installCommand", value.trim() || null)}
          placeholder="pnpm install"
          value={profile.installCommand ?? ""}
        />
        <ProfileField
          label="Build command"
          onChange={(value) => update("buildCommand", value.trim() || null)}
          placeholder="pnpm build"
          value={profile.buildCommand ?? ""}
        />
        <ProfileField
          label="Test command"
          onChange={(value) => update("testCommand", value.trim() || null)}
          placeholder="pnpm test"
          value={profile.testCommand ?? ""}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Language hints</span>
          <textarea
            className="ui-textarea min-h-24 w-full"
            onChange={(event) => update("languageHints", splitList(event.target.value))}
            value={joinList(profile.languageHints)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Framework hints</span>
          <textarea
            className="ui-textarea min-h-24 w-full"
            onChange={(event) => update("frameworkHints", splitList(event.target.value))}
            value={joinList(profile.frameworkHints)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Env key suggestions</span>
          <textarea
            className="ui-textarea min-h-28 w-full font-mono text-[12px]"
            onChange={(event) => update("envKeySuggestions", splitList(event.target.value))}
            value={joinList(profile.envKeySuggestions)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Setup notes</span>
          <textarea
            className="ui-textarea min-h-28 w-full"
            onChange={(event) => update("setupNotes", event.target.value)}
            value={profile.setupNotes}
          />
        </label>
      </div>

      <div className="mt-4">
        <p className="text-[12px] font-medium text-muted">Source files</p>
        {profile.inferenceSources.length === 0 ? (
          <p className="mt-1 text-[12px] leading-5 text-muted">No source files matched.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {profile.inferenceSources.map((source) => (
              <span className="ui-pill font-mono" key={source.path}>
                {source.path}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
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
          className="flex items-start justify-between gap-3 rounded-[6px] border border-border bg-surface-strong px-3 py-2"
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
  onCompleted,
  onDataChange,
  onRuntimeStateChange,
}: {
  data: WorkspaceOnboardingData;
  isSaving: boolean;
  onCompleted: (action: string) => Promise<void>;
  onDataChange: (data: WorkspaceOnboardingData) => void;
  onRuntimeStateChange: (state: RuntimeCompletionState) => void;
}) {
  const [drafts, setDrafts] = useState<AgentConfigDrafts>(() =>
    buildAgentConfigDrafts(data.agentConfig),
  );
  const [secretKey, setSecretKey] = useState(
    data.github.primaryProfile?.envKeySuggestions.find(
      (key) => !data.setupHealth.workspaceSecrets.configuredKeys.includes(key),
    ) ??
      data.github.primaryProfile?.envKeySuggestions[0] ??
      "",
  );
  const [secretValue, setSecretValue] = useState("");
  const [runtimeMessage, setRuntimeMessage] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [verifyState, setVerifyState] = useState<{
    isVerifying: boolean;
    result: VerifyAgentConfigResponse | null;
  }>({ isVerifying: false, result: null });
  const fields = AGENT_CONFIG_FIELDS;
  const savedDrafts = buildAgentConfigDrafts(data.agentConfig);
  const fieldStatuses = fields.map((field) => {
    const draft = drafts[field.configKey];
    const validation = parseDraftForKey(field.configKey, field.type, draft);
    const isDirty = draft !== savedDrafts[field.configKey];
    return {
      draft,
      field,
      isDirty,
      validation,
      validationError: validation.ok ? null : validation.error,
    };
  });
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
  const envSuggestions = data.github.primaryProfile?.envKeySuggestions ?? [];
  const configuredSecretKeys = new Set(data.workspaceSecrets.map((secret) => secret.key));
  const missingDefaultKeys = ALLOWED_AGENT_CONFIG_KEYS.filter(
    (key) =>
      data.agentConfig[key] === undefined &&
      drafts[key] === configValueToString(RECOMMENDED_AGENT_CONFIG_DEFAULTS[key]),
  );
  const canSaveConfig =
    data.canManage &&
    !isSaving &&
    busyAction === null &&
    !hasInvalidDrafts &&
    fieldStatuses.some((status) => status.isDirty);
  const canApplyDefaults =
    data.canManage && !isSaving && busyAction === null && missingDefaultKeys.length > 0;
  const canSaveSecret =
    data.canManage &&
    !isSaving &&
    busyAction === null &&
    Boolean(secretKey.trim()) &&
    Boolean(secretValue.trim());
  const canVerify =
    data.canManage &&
    !isSaving &&
    busyAction === null &&
    !verifyState.isVerifying &&
    !hasInvalidDrafts &&
    drafts.agent_model.trim() !== "";
  const canCompleteRuntime =
    data.canManage &&
    !isSaving &&
    busyAction === null &&
    !hasInvalidDrafts &&
    !hasUnsavedDrafts &&
    readiness.canComplete;

  useEffect(() => {
    onRuntimeStateChange({ hasInvalidDrafts, hasUnsavedDrafts, readiness });
  }, [hasInvalidDrafts, hasUnsavedDrafts, onRuntimeStateChange, readiness, readinessSignature]);

  function handleFieldChange(key: AgentConfigKey, next: string) {
    setDrafts((current) => ({ ...current, [key]: next }));
    if (key === "agent_model" || key === "agent_provider") {
      setVerifyState({ isVerifying: false, result: null });
    }
  }

  async function handleSaveConfig() {
    if (!canSaveConfig) return;
    setBusyAction("config");
    setRuntimeError(null);
    setRuntimeMessage(null);
    const entries: Array<{ key: string; value: unknown }> = [];

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
        entries.push(body.entry);
      }

      if (entries.length > 0) {
        onDataChange(updateAgentConfigInData(data, entries));
        setRuntimeMessage(
          `Saved ${entries.length} agent setting${entries.length === 1 ? "" : "s"}.`,
        );
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
            (key) =>
              data.agentConfig[key] === undefined &&
              drafts[key] !== configValueToString(RECOMMENDED_AGENT_CONFIG_DEFAULTS[key]),
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

  async function handleSaveSecret() {
    if (!canSaveSecret) return;
    setBusyAction("secret");
    setRuntimeError(null);
    setRuntimeMessage(null);

    try {
      const response = await fetch("/api/secrets", {
        body: JSON.stringify({
          key: secretKey.trim().toUpperCase(),
          value: secretValue,
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
      onDataChange(updateSecretInData(data, body.secret));
      setSecretValue("");
      setRuntimeMessage(`Saved preview for ${body.secret.key}.`);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Workspace secret save failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleVerifyModel() {
    if (!canVerify) return;
    setVerifyState({ isVerifying: true, result: null });
    setRuntimeError(null);

    try {
      const response = await fetch("/api/agent-config/verify", {
        body: JSON.stringify({
          model: drafts.agent_model.trim(),
          provider: selectedProvider,
          workspaceId: data.workspace.id,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as
        | (VerifyAgentConfigResponse & { error?: string })
        | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? "Verify call failed.");
      }
      setVerifyState({ isVerifying: false, result: body });
    } catch (error) {
      setVerifyState({
        isVerifying: false,
        result: {
          ok: false,
          error: error instanceof Error ? error.message : "Verify call failed.",
        },
      });
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

      <div className="rounded-[6px] border border-border bg-background p-4">
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
          {fieldStatuses.map((status) => (
            <label className="block space-y-1.5" key={status.field.configKey}>
              <span className="text-[12px] font-medium text-muted">{status.field.label}</span>
              {status.field.type === "select" && status.field.options ? (
                <select
                  className="ui-input"
                  disabled={busyAction !== null}
                  onChange={(event) =>
                    handleFieldChange(status.field.configKey, event.target.value)
                  }
                  value={status.draft}
                >
                  {status.field.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
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
              )}
              {status.validationError ? (
                <p className="text-[12px] leading-5 text-danger" role="alert">
                  {status.validationError}
                </p>
              ) : (
                <p className="text-[12px] leading-5 text-muted">{status.field.description}</p>
              )}
            </label>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div className="min-w-0 text-[12px] leading-5 text-muted">
            {hasUnsavedDrafts
              ? "Save agent config before completing Runtime."
              : "No unsaved changes."}
            {verifyState.result ? (
              <span
                className={cn(
                  "ml-2",
                  verifyState.result.ok === true
                    ? "text-success"
                    : verifyState.result.ok === "skipped"
                      ? "text-muted"
                      : "text-danger",
                )}
                role="status"
              >
                {verifyState.result.ok === true
                  ? "Reachable"
                  : verifyState.result.ok === "skipped"
                    ? verifyState.result.reason
                    : verifyState.result.error}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="ui-button"
              disabled={!canVerify}
              onClick={() => void handleVerifyModel()}
              type="button"
            >
              {verifyState.isVerifying ? "Verifying..." : "Verify model"}
            </button>
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
      </div>

      <div className="rounded-[6px] border border-border bg-background p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-foreground">Workspace secrets</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Values are encrypted server-side; only previews are returned.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {envSuggestions.length === 0 ? (
                <p className="text-[13px] text-muted">
                  No env keys suggested by the repository profile.
                </p>
              ) : (
                envSuggestions.map((key) => (
                  <div
                    className="flex min-h-11 items-center justify-between gap-3 rounded-[6px] border border-border bg-surface-strong px-3 py-2"
                    key={key}
                  >
                    <span className="min-w-0 truncate font-mono text-[12px] text-foreground">
                      {key}
                    </span>
                    <Badge tone={configuredSecretKeys.has(key) ? "success" : "warning"}>
                      {configuredSecretKeys.has(key) ? "Present" : "Missing"}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="w-full shrink-0 space-y-3 lg:w-72">
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted">Secret key</span>
              <input
                autoCapitalize="characters"
                autoComplete="off"
                className="ui-input"
                disabled={busyAction !== null}
                onChange={(event) => setSecretKey(event.target.value)}
                placeholder="ANTHROPIC_API_KEY"
                spellCheck={false}
                value={secretKey}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[12px] font-medium text-muted">Secret value</span>
              <textarea
                autoComplete="off"
                className="ui-textarea min-h-24"
                disabled={busyAction !== null}
                onChange={(event) => setSecretValue(event.target.value)}
                placeholder="Paste value..."
                value={secretValue}
              />
            </label>
            <button
              className="ui-button-primary w-full"
              disabled={!canSaveSecret}
              onClick={() => void handleSaveSecret()}
              type="button"
            >
              {busyAction === "secret" ? "Saving..." : "Save secret"}
            </button>
          </div>
        </div>
      </div>

      {selectedProvider === "codex" ? (
        <div className="rounded-[6px] border border-border bg-background p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-foreground">Codex account</h3>
              <p className="mt-1 text-[12px] leading-5 text-muted">
                Runtime checks the current user&apos;s Codex connection.
              </p>
            </div>
          </div>
          <CodexConnectionPanel returnTo={`/w/${data.workspace.slug}/onboarding?step=runtime`} />
        </div>
      ) : null}

      <div className="rounded-[6px] border border-border bg-background p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Runtime readiness</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Provider-specific requirements must pass before this step can complete.
            </p>
          </div>
          <Badge tone={canCompleteRuntime ? "success" : "warning"}>
            {canCompleteRuntime ? "Ready" : "Blocked"}
          </Badge>
        </div>
        <div className="mt-4">
          <RuntimeRequirementList requirements={readiness.requirements} />
        </div>
        <div className="mt-4 flex justify-end">
          <button
            className="ui-button-primary"
            disabled={!canCompleteRuntime}
            onClick={() => void onCompleted("runtime")}
            type="button"
          >
            {isSaving ? "Saving..." : "Complete runtime"}
          </button>
        </div>
      </div>
    </div>
  );
}

function sandboxStatusTone(check: SandboxCapabilityCheckState | null): HealthTone {
  if (!check) return "warning";
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
  onDataChange: (data: WorkspaceOnboardingData) => void;
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

  useEffect(() => {
    if (!primaryRepositoryId || check?.status !== "running") return;

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
        setCheck(body.check);
        onDataChange({
          ...data,
          setupHealth: {
            ...data.setupHealth,
            latestSandboxCapabilityCheck: body.check,
          },
        });
        if (body.check.status === "success" || body.check.status === "error") {
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
  }, [check?.status, data, onDataChange, primaryRepositoryId]);

  async function runCapabilityCheck() {
    if (!primaryRepositoryId || busyAction !== null) return;
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
      onDataChange({
        ...data,
        setupHealth: {
          ...data.setupHealth,
          latestSandboxCapabilityCheck: body.check,
        },
      });
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

      <div className="rounded-[6px] border border-border bg-background p-4">
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
              className="flex flex-col gap-3 rounded-[6px] border border-border bg-surface-strong px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
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

      <div className="rounded-[6px] border border-border bg-background p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">Sandbox capability</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Checks run against the selected primary repository only.
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
            disabled={!primaryRepositoryId || busyAction !== null || isPolling}
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

function StepBody({
  data,
  isSaving,
  onCompleteStep,
  onDataChange,
  onInferRepository,
  onRefresh,
  onRepositoryProfileSaved,
  onRuntimeStateChange,
  onSelectStep,
  onSelectRepository,
  profileBusy,
  profileDirty,
  profileDraft,
  profileError,
  selectedRepositoryId,
  step,
  updateProfileDraft,
}: {
  data: WorkspaceOnboardingData;
  isSaving: boolean;
  onCompleteStep: (action: string) => Promise<void>;
  onDataChange: (data: WorkspaceOnboardingData) => void;
  onInferRepository: (repository: WorkspaceGitHubRepository) => void;
  onRefresh: (action: string) => Promise<void>;
  onRepositoryProfileSaved: () => void;
  onRuntimeStateChange: (state: RuntimeCompletionState) => void;
  onSelectStep: (step: WorkspaceOnboardingStep) => void;
  onSelectRepository: (repository: WorkspaceGitHubRepository) => void;
  profileBusy: boolean;
  profileDirty: boolean;
  profileDraft: EditableProfile | null;
  profileError: string | null;
  selectedRepositoryId: string | null;
  step: WorkspaceOnboardingStep;
  updateProfileDraft: (profile: EditableProfile, dirty?: boolean) => void;
}) {
  const rows = stepHealthItems(step, data.setupHealth);
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
      setupHealth: applyGithubHealth(data.setupHealth, github),
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
      <div className="space-y-4">
        {profileError ? (
          <div
            className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
            role="alert"
          >
            {profileError}
          </div>
        ) : null}
        <GitHubConnectionPanel
          canManage={data.canManage && !isSaving}
          github={data.github}
          hideArchivedRepositories
          onChange={updateGithub}
          onSelectRepository={(repositoryId) => {
            const repository = data.github.repositories.find((item) => item.id === repositoryId);
            if (repository) onSelectRepository(repository);
          }}
          renderRepositoryDetails={(repository) =>
            selectedRepositoryId === repository.id && profileDraft ? (
              <RepositoryProfileEditor
                canManage={data.canManage && !isSaving}
                isBusy={profileBusy}
                isDirty={profileDirty}
                onChange={updateProfileDraft}
                onInfer={() => onInferRepository(repository)}
                onSave={onRepositoryProfileSaved}
                profile={profileDraft}
              />
            ) : profileBusy && selectedRepositoryId === repository.id ? (
              <div className="rounded-[6px] border border-border bg-background px-3 py-2 text-[13px] text-muted">
                Inferring repository setup...
              </div>
            ) : null
          }
          selectedRepositoryId={selectedRepositoryId}
          source="onboarding"
          workspaceId={data.workspace.id}
        />
      </div>
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
        onCompleted={onCompleteStep}
        onDataChange={onDataChange}
        onRuntimeStateChange={onRuntimeStateChange}
      />
    );
  } else if (step === "verify") {
    controls = <VerifyStep data={data} onDataChange={onDataChange} onSelectStep={onSelectStep} />;
  } else {
    controls = (
      <div className="rounded-[6px] border border-border bg-background p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">
              {step === "verify" ? "Setup health" : "Controls"}
            </h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              {step === "verify"
                ? "Review the health summary, then complete setup when the required signals are ready."
                : "Use the linked settings area for now; this step will receive inline controls in a later integration issue."}
            </p>
          </div>
          {primaryHref ? (
            <Link className="ui-button shrink-0" href={primaryHref}>
              Open settings
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={`${step}-${row.label}`}
            className="flex min-h-12 items-center justify-between gap-3 rounded-[6px] border border-border bg-surface-strong px-3 py-2"
          >
            <span className="min-w-0 text-[12px] font-medium text-muted">{row.label}</span>
            <Badge tone={row.tone}>{row.value}</Badge>
          </div>
        ))}
      </div>

      {controls}
    </div>
  );
}

function StepRail({
  canManage,
  items,
  onSelect,
}: {
  canManage: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <ol className="space-y-2">
      {items.map((step) => (
        <li key={step.id}>
          <button
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-[8px] border px-3 py-2.5 text-left transition-colors",
              railStateClasses[step.displayState],
              (!canManage || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canManage || !step.isNavigable}
            onClick={() => onSelect(step.id)}
          >
            <StepStateIcon state={step.displayState} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{step.title}</span>
              <span className="mt-0.5 block text-[11px] text-current opacity-75">
                {stepStateLabels[step.displayState]}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function MobileStepControl({
  canManage,
  items,
  onSelect,
}: {
  canManage: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <div className="border-b border-border bg-surface px-3 py-2 lg:hidden">
      <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Setup steps">
        {items.map((step) => (
          <button
            key={step.id}
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "inline-flex h-9 min-w-[112px] items-center justify-center gap-1.5 rounded-[6px] border px-2 text-[12px] font-medium",
              railStateClasses[step.displayState],
              (!canManage || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canManage || !step.isNavigable}
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
    <aside className="ui-panel h-fit p-4">
      <h2 className="text-[14px] font-semibold text-foreground">Setup health</h2>
      <div className="mt-4 space-y-3">
        {setupHealthItems(health).map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-foreground">{item.label}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted">{item.detail}</p>
            </div>
            <Badge tone={item.tone}>{item.value}</Badge>
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
    setupHealth: applyGithubHealth(currentData.setupHealth, nextGithub),
  };
}

export function buildRepositoryProfileAutoContinuePatch(
  onboarding: WorkspaceOnboardingData["onboarding"],
): WorkspaceOnboardingUpdatePayload | null {
  if (onboarding.currentStep !== "repository") return null;
  return buildOnboardingContinuePatch(onboarding);
}

function initialProfileDraft(data: WorkspaceOnboardingData): EditableProfile | null {
  const primaryRepositoryId = data.github.primaryProfile?.githubRepositoryId;
  if (!primaryRepositoryId) return null;
  return (
    data.github.repositories.find((repository) => repository.id === primaryRepositoryId)?.profile ??
    data.github.primaryProfile
  );
}

export function OnboardingPageClient({ initialData }: OnboardingPageClientProps) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [error, setError] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
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
    initialData.github.primaryProfile?.githubRepositoryId ?? null,
  );
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const latestDataRef = useRef(data);
  const selectedRepositoryIdRef = useRef(selectedRepositoryId);
  const onboarding = data.onboarding;
  latestDataRef.current = data;
  selectedRepositoryIdRef.current = selectedRepositoryId;
  const activeStep = ONBOARDING_STEPS.find((step) => step.id === onboarding.currentStep)!;
  const railItems = useMemo(() => getOnboardingStepRailItems(onboarding), [onboarding]);
  const canGoBack = onboardingStepIndex(onboarding.currentStep) > 0;
  const isCompleted = onboarding.status === "completed";
  const isSaving = savingAction !== null;
  const activeStepAlreadyResolved =
    onboarding.completedSteps.includes(activeStep.id) ||
    onboarding.skippedSteps.includes(activeStep.id);
  const pipelineEditorUnavailable = activeStep.id === "pipeline" && !data.pipeline;
  const linearRoutingUnavailable =
    activeStep.id === "linear" && (!data.pipeline || data.pipeline.stages.length === 0);
  const inlineCompletionUnavailable = pipelineEditorUnavailable || linearRoutingUnavailable;
  const requiresInlineCompletion =
    (activeStep.id === "pipeline" || activeStep.id === "linear" || activeStep.id === "runtime") &&
    !inlineCompletionUnavailable &&
    !activeStepAlreadyResolved;
  const repositoryContinueBlocked =
    activeStep.id === "repository" && !data.setupHealth.primaryRepositoryProfile.configured;
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
    const nextData = await persistOnboarding(
      buildOnboardingContinuePatch(latestDataRef.current.onboarding),
      action,
    );
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
    const patch = buildOnboardingRailNavigationPatch(onboarding, step);
    if (!patch) return;
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
    setProfileBusy(true);

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
        setProfileBusy(false);
      }
    }
  }

  async function selectRepository(repository: WorkspaceGitHubRepository) {
    selectedRepositoryIdRef.current = repository.id;
    setSelectedRepositoryId(repository.id);
    setProfileError(null);

    if (repository.profile) {
      setProfileDraft(repository.profile);
      setProfileDirty(false);
      setProfileBusy(false);
      return;
    }

    await inferRepositoryProfile(repository);
  }

  async function saveRepositoryProfile() {
    if (!profileDraft || !selectedRepositoryId || profileBusy) return;

    const repositoryIdToSave = selectedRepositoryId;
    const profileToSave = profileDraft;
    setProfileBusy(true);
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

      const autoContinuePatch = buildRepositoryProfileAutoContinuePatch(
        latestDataRef.current.onboarding,
      );
      if (autoContinuePatch) {
        await persistOnboarding(autoContinuePatch, "repository-profile");
      }
    } catch (caught) {
      setProfileError(
        caught instanceof Error ? caught.message : "Failed to save repository profile.",
      );
    } finally {
      setProfileBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted">Workspace setup</p>
          <h1 className="truncate text-[15px] font-semibold text-foreground">
            {data.workspace.name}
          </h1>
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

      <MobileStepControl
        canManage={data.canManage && !isSaving}
        items={railItems}
        onSelect={selectStep}
      />

      <main
        id="main-content"
        className="grid flex-1 grid-cols-1 gap-4 p-4 pb-24 lg:grid-cols-[220px_minmax(0,1fr)_280px] lg:p-6 lg:pb-24"
      >
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <p className="mb-3 text-[11px] font-medium text-muted">Progress</p>
            <StepRail
              canManage={data.canManage && !isSaving}
              items={railItems}
              onSelect={selectStep}
            />
          </div>
        </aside>

        <section className="ui-panel min-w-0 p-5 sm:p-6">
          <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    isCompleted
                      ? "success"
                      : onboarding.status === "dismissed"
                        ? "neutral"
                        : "accent"
                  }
                >
                  {isCompleted
                    ? "Completed"
                    : onboarding.status === "dismissed"
                      ? "Dismissed"
                      : onboarding.status === "not_started"
                        ? "Not started"
                        : "In progress"}
                </Badge>
                <span className="text-[12px] text-muted">
                  Step {onboardingStepIndex(activeStep.id) + 1} of {ONBOARDING_STEPS.length}
                </span>
              </div>
              <h2 className="mt-3 text-[24px] font-semibold text-foreground">{activeStep.title}</h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
                {activeStep.description}
              </p>
            </div>
            <Badge
              tone={
                railItems.find((step) => step.id === activeStep.id)?.displayState === "completed"
                  ? "success"
                  : railItems.find((step) => step.id === activeStep.id)?.displayState === "skipped"
                    ? "warning"
                    : "accent"
              }
            >
              {
                stepStateLabels[
                  railItems.find((step) => step.id === activeStep.id)?.displayState ?? "active"
                ]
              }
            </Badge>
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
              onDataChange={setData}
              onInferRepository={(repository) => void inferRepositoryProfile(repository)}
              onRefresh={async (action) => {
                const nextData = await refreshOnboarding(action);
                if (!nextData) {
                  throw new Error("Failed to refresh onboarding state.");
                }
              }}
              onRepositoryProfileSaved={() => void saveRepositoryProfile()}
              onRuntimeStateChange={setRuntimeCompletionState}
              onSelectStep={(step) => void selectStep(step)}
              onSelectRepository={(repository) => void selectRepository(repository)}
              profileBusy={profileBusy}
              profileDirty={profileDirty}
              profileDraft={profileDraft}
              profileError={profileError}
              selectedRepositoryId={selectedRepositoryId}
              step={activeStep.id}
              updateProfileDraft={updateProfileDraft}
            />
          </div>
        </section>

        <SetupHealthSummary health={data.setupHealth} />
      </main>

      <footer className="sticky bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-[12px] text-muted">
            {data.canManage
              ? "Progress is saved to this workspace."
              : "Ask a workspace admin to update setup progress."}
          </div>
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
