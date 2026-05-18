"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  ApplyAgentConfigDefaultsResponse,
  UpsertAgentConfigResponse,
} from "@/app/api/agent-config/route";
import type { VerifyAgentConfigResponse } from "@/app/api/agent-config/verify/route";
import { CheckIcon, CodeIcon, PlusIcon, ProjectsIcon, SparkIcon } from "@/components/shared/icons";
import { SelectField } from "@/components/ui/select";
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
import type {
  UpsertWorkspaceSecretResponse,
  WorkspaceSecretPreview,
} from "@/lib/secrets/contracts";
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

type EditableProfile = RepositoryProfileState;
type AgentConfigDrafts = Record<AgentConfigKey, string>;
type FieldType = "number" | "select" | "text";
type ProfileHintKind = "framework" | "language" | "package";
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
  options?: readonly string[];
  placeholder?: string;
  type: FieldType;
};

type RuntimeCredentialDescriptor = {
  description: string;
  key: string;
  label: string;
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

const profileHintLabel: Record<ProfileHintKind, string> = {
  framework: "Framework",
  language: "Language",
  package: "Package manager",
};

const profileHintIconMap: Record<
  ProfileHintKind,
  Record<string, { bg: string; fg: string; text: string }>
> = {
  framework: {
    angular: { bg: "#dd0031", fg: "#ffffff", text: "A" },
    astro: { bg: "#2f2148", fg: "#ffffff", text: "A" },
    django: { bg: "#092e20", fg: "#ffffff", text: "Dj" },
    express: { bg: "#24292f", fg: "#ffffff", text: "Ex" },
    flask: { bg: "#24292f", fg: "#ffffff", text: "Fl" },
    nest: { bg: "#e0234e", fg: "#ffffff", text: "Ns" },
    nestjs: { bg: "#e0234e", fg: "#ffffff", text: "Ns" },
    next: { bg: "#111111", fg: "#ffffff", text: "N" },
    nextjs: { bg: "#111111", fg: "#ffffff", text: "N" },
    playwright: { bg: "#2ead33", fg: "#ffffff", text: "Pw" },
    rails: { bg: "#cc0000", fg: "#ffffff", text: "Rl" },
    react: { bg: "#149eca", fg: "#ffffff", text: "R" },
    remix: { bg: "#111111", fg: "#ffffff", text: "Rx" },
    svelte: { bg: "#ff3e00", fg: "#ffffff", text: "S" },
    supabase: { bg: "#3ecf8e", fg: "#0b3727", text: "S" },
    tailwind: { bg: "#38bdf8", fg: "#082f49", text: "Tw" },
    tailwindcss: { bg: "#38bdf8", fg: "#082f49", text: "Tw" },
    turbo: { bg: "#ef4444", fg: "#ffffff", text: "T" },
    turborepo: { bg: "#ef4444", fg: "#ffffff", text: "T" },
    vite: { bg: "#646cff", fg: "#ffffff", text: "V" },
    vue: { bg: "#42b883", fg: "#0f2f24", text: "V" },
  },
  language: {
    bash: { bg: "#4eaa25", fg: "#ffffff", text: "sh" },
    c: { bg: "#555555", fg: "#ffffff", text: "C" },
    cpp: { bg: "#00599c", fg: "#ffffff", text: "C++" },
    csharp: { bg: "#68217a", fg: "#ffffff", text: "C#" },
    css: { bg: "#1572b6", fg: "#ffffff", text: "CSS" },
    dart: { bg: "#0175c2", fg: "#ffffff", text: "Da" },
    go: { bg: "#00add8", fg: "#06262f", text: "Go" },
    golang: { bg: "#00add8", fg: "#06262f", text: "Go" },
    html: { bg: "#e34f26", fg: "#ffffff", text: "HT" },
    java: { bg: "#e76f00", fg: "#ffffff", text: "Ja" },
    javascript: { bg: "#f7df1e", fg: "#1d1f22", text: "JS" },
    js: { bg: "#f7df1e", fg: "#1d1f22", text: "JS" },
    kotlin: { bg: "#7f52ff", fg: "#ffffff", text: "Kt" },
    php: { bg: "#777bb4", fg: "#ffffff", text: "PHP" },
    python: { bg: "#3776ab", fg: "#ffffff", text: "Py" },
    ruby: { bg: "#cc342d", fg: "#ffffff", text: "Rb" },
    rust: { bg: "#b7410e", fg: "#ffffff", text: "Rs" },
    shell: { bg: "#4eaa25", fg: "#ffffff", text: "sh" },
    swift: { bg: "#f05138", fg: "#ffffff", text: "Sw" },
    ts: { bg: "#3178c6", fg: "#ffffff", text: "TS" },
    typescript: { bg: "#3178c6", fg: "#ffffff", text: "TS" },
  },
  package: {
    bun: { bg: "#f0dbb4", fg: "#1d1f22", text: "B" },
    cargo: { bg: "#b7410e", fg: "#ffffff", text: "Cg" },
    go: { bg: "#00add8", fg: "#06262f", text: "Go" },
    npm: { bg: "#cb3837", fg: "#ffffff", text: "npm" },
    pip: { bg: "#3776ab", fg: "#ffffff", text: "pip" },
    pnpm: { bg: "#f9ad00", fg: "#1d1f22", text: "pn" },
    poetry: { bg: "#60a5fa", fg: "#082f49", text: "Po" },
    uv: { bg: "#111827", fg: "#ffffff", text: "uv" },
    yarn: { bg: "#2c8ebb", fg: "#ffffff", text: "Y" },
  },
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

function SecretValueTextarea({
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
    <textarea
      aria-label={ariaLabel}
      autoComplete="off"
      className="ui-textarea min-h-20 min-w-0 flex-1 resize-y font-mono text-[13px]"
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      value={value}
    />
  );
}

function HealthBadge({ children, tone }: { children: string; tone: HealthTone }) {
  return (
    <span
      className={cn(
        "ui-badge whitespace-nowrap",
        tone === "success" ? "ui-badge-success" : "ui-badge-neutral",
      )}
    >
      <span className="ui-badge-dot" />
      {children}
    </span>
  );
}

function normalizeProfileHint(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.js$/u, "js")
    .replace(/[^a-z0-9+#]+/gu, "");
}

function ProfileHintIcon({ kind, value }: { kind: ProfileHintKind; value: string }) {
  const icon = profileHintIconMap[kind][normalizeProfileHint(value)];

  if (icon) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[4px] px-1 text-[8px] font-bold leading-none"
        style={{ backgroundColor: icon.bg, color: icon.fg }}
      >
        {icon.text}
      </span>
    );
  }

  const className = "h-3.5 w-3.5 text-muted";
  if (kind === "package") return <ProjectsIcon className={className} />;
  if (kind === "framework") return <SparkIcon className={className} />;
  return <CodeIcon className={className} />;
}

function ProfileHintPill({ kind, value }: { kind: ProfileHintKind; value: string }) {
  const label = `${profileHintLabel[kind]}: ${value}`;

  return (
    <span aria-label={label} className="ui-pill gap-1.5" title={label}>
      <ProfileHintIcon kind={kind} value={value} />
      {value}
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

function secretBusyActionKey(key: string) {
  return `secret:${normalizeSecretKey(key)}`;
}

function secretPreviewLabel(secret: WorkspaceSecretPreview | undefined) {
  if (!secret) {
    return "Not saved";
  }

  return secret.valuePreview ? `Stored ${secret.valuePreview}` : "Stored value";
}

function repositoryVariableKeys(
  envSuggestions: readonly string[],
  workspaceSecrets: readonly WorkspaceSecretPreview[],
  runtimeCredentialKeys: ReadonlySet<string>,
) {
  const keys = new Set<string>();
  const rows: string[] = [];
  const addKey = (rawKey: string) => {
    const key = normalizeSecretKey(rawKey);
    if (!key || key === "LINEAR_API_KEY" || runtimeCredentialKeys.has(key) || keys.has(key)) {
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

export function RepositoryProfileEditor({
  canManage,
  isAnalyzing,
  isSaving,
  onChange,
  onInfer,
  onSave,
  profile,
  reanalyzeLabel = "Re-analyze",
}: {
  canManage: boolean;
  isAnalyzing: boolean;
  isSaving: boolean;
  onChange: (profile: EditableProfile, dirty?: boolean) => void;
  onInfer: () => void;
  onSave: () => void;
  profile: EditableProfile;
  reanalyzeLabel?: string;
}) {
  const actionsDisabled = isAnalyzing || isSaving;

  function update<K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) {
    onChange({ ...profile, [key]: value, inferenceConfidence: "manual" }, true);
  }

  return (
    <div className="rounded-[6px] border border-border bg-surface p-4">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-foreground">Repository profile</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {profile.packageManager ? (
              <ProfileHintPill kind="package" value={profile.packageManager} />
            ) : null}
            {profile.languageHints.map((hint) => (
              <ProfileHintPill kind="language" key={hint} value={hint} />
            ))}
            {profile.frameworkHints.map((hint) => (
              <ProfileHintPill kind="framework" key={hint} value={hint} />
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            className="ui-button"
            disabled={!canManage || actionsDisabled}
            onClick={onInfer}
            type="button"
          >
            {isAnalyzing ? "Analyzing..." : reanalyzeLabel}
          </button>
          <button
            className="ui-button-primary"
            disabled={!canManage || actionsDisabled}
            onClick={onSave}
            type="button"
          >
            {isSaving ? "Saving..." : "Save profile"}
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
  onCompleted,
  onDataChange,
  onRuntimeStateChange,
}: {
  data: WorkspaceOnboardingData;
  isSaving: boolean;
  onCompleted: (action: string) => Promise<void>;
  onDataChange: OnboardingDataChange;
  onRuntimeStateChange: (state: RuntimeCompletionState) => void;
}) {
  const [drafts, setDrafts] = useState<AgentConfigDrafts>(() =>
    buildAgentConfigDrafts(data.agentConfig),
  );
  const [secretValueDrafts, setSecretValueDrafts] = useState<Record<string, string>>({});
  const [newSecretKey, setNewSecretKey] = useState("");
  const [newSecretValue, setNewSecretValue] = useState("");
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
  const secretByKey = new Map(
    data.workspaceSecrets.map((secret) => [normalizeSecretKey(secret.key), secret]),
  );
  const configuredSecretKeys = new Set(
    data.workspaceSecrets.map((secret) => normalizeSecretKey(secret.key)),
  );
  const runtimeCredentials: RuntimeCredentialDescriptor[] = [];
  const runtimeCredentialKeys = new Set(
    runtimeCredentials.map((credential) => normalizeSecretKey(credential.key)),
  );
  const repositoryVariables = repositoryVariableKeys(
    envSuggestions,
    data.workspaceSecrets,
    runtimeCredentialKeys,
  );
  const repositorySecretDrafts = repositoryVariables
    .map((key) => ({ key, value: secretValueDrafts[key] ?? "" }))
    .filter((draft) => Boolean(draft.value.trim()));
  const hasCompleteNewSecret = Boolean(newSecretKey.trim()) && Boolean(newSecretValue.trim());
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
  const canSaveRepositoryConfig =
    data.canManage &&
    !isSaving &&
    busyAction === null &&
    (repositorySecretDrafts.length > 0 || hasCompleteNewSecret);

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
        setRuntimeMessage(`Saved ${savedCount} agent setting${savedCount === 1 ? "" : "s"}.`);
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

  function handleSecretDraftChange(key: string, value: string) {
    setSecretValueDrafts((current) => ({ ...current, [normalizeSecretKey(key)]: value }));
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

  async function handleSaveSecret(key: string, value: string) {
    const normalizedKey = normalizeSecretKey(key);
    if (!data.canManage || isSaving || busyAction !== null || !normalizedKey || !value.trim()) {
      return;
    }

    setBusyAction(secretBusyActionKey(normalizedKey));
    setRuntimeError(null);
    setRuntimeMessage(null);

    try {
      const secret = await upsertWorkspaceSecret(normalizedKey, value);
      onDataChange(updateSecretInData(data, secret));
      setSecretValueDrafts((current) => {
        const next = { ...current };
        delete next[key];
        delete next[normalizedKey];
        return next;
      });
      setRuntimeMessage(`Saved preview for ${secret.key}.`);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "Workspace secret save failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveRepositoryConfig() {
    if (!canSaveRepositoryConfig) return;

    const entriesByKey = new Map<string, { key: string; value: string }>();
    for (const draft of repositorySecretDrafts) {
      entriesByKey.set(normalizeSecretKey(draft.key), draft);
    }
    if (hasCompleteNewSecret) {
      entriesByKey.set(normalizeSecretKey(newSecretKey), {
        key: newSecretKey,
        value: newSecretValue,
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
      if (hasCompleteNewSecret) {
        setNewSecretKey("");
        setNewSecretValue("");
      }
      setRuntimeMessage(
        `Saved ${entries.length} environment variable${entries.length === 1 ? "" : "s"}.`,
      );
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
          {fieldStatuses.map((status) => (
            <div className="block space-y-1.5" key={status.field.configKey}>
              {status.field.type === "select" && status.field.options ? (
                <SelectField
                  disabled={busyAction !== null}
                  label={status.field.label}
                  onValueChange={(value) => handleFieldChange(status.field.configKey, value)}
                  options={status.field.options.map((option) => ({ label: option, value: option }))}
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

      <div className="space-y-4">
        <div className="rounded-[6px] border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-[14px] font-semibold text-foreground">Runtime credentials</h3>
            <p className="mt-1 text-[12px] leading-5 text-muted">
              Agent-only secrets are encrypted server-side; only previews are returned.
            </p>
          </div>

          {runtimeCredentials.length === 0 ? (
            <p className="px-4 py-3 text-[13px] leading-5 text-muted">
              No encrypted workspace secret is required for the selected {selectedProvider} runner.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {runtimeCredentials.map((credential) => {
                const configured = configuredSecretKeys.has(credential.key);
                const draftValue = secretValueDrafts[normalizeSecretKey(credential.key)] ?? "";
                const isSavingSecret = busyAction === secretBusyActionKey(credential.key);
                const canSaveCredential =
                  data.canManage && !isSaving && busyAction === null && Boolean(draftValue.trim());

                return (
                  <div className="space-y-2 px-4 py-3" key={credential.key}>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <p className="text-[13px] font-medium text-foreground">{credential.label}</p>
                      <code className="break-all font-mono text-[12px] text-foreground">
                        {credential.key}
                      </code>
                      <Badge tone={configured ? "success" : "warning"}>
                        {configured ? "Present" : "Missing"}
                      </Badge>
                    </div>

                    <div className="flex min-w-0 items-start gap-2">
                      <SecretValueTextarea
                        ariaLabel={`Value for ${credential.key}`}
                        disabled={busyAction !== null}
                        onChange={(value) => handleSecretDraftChange(credential.key, value)}
                        value={draftValue}
                      />
                      <button
                        aria-label={`${configured ? "Update" : "Save"} ${credential.key}`}
                        className={cn(
                          "h-10 w-10 shrink-0 !px-0 !py-0",
                          canSaveCredential ? "ui-button-primary" : "ui-button",
                        )}
                        disabled={!canSaveCredential}
                        onClick={() => void handleSaveSecret(credential.key, draftValue)}
                        title={configured ? "Update" : "Save"}
                        type="button"
                      >
                        {isSavingSecret ? (
                          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-current" />
                        ) : (
                          <CheckIcon className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

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

                    <SecretValueTextarea
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

          <div className="border-t border-border bg-surface-strong px-4 py-4">
            <div className="space-y-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <PlusIcon className="h-3.5 w-3.5 text-muted" />
                <input
                  aria-label="New variable name"
                  autoCapitalize="characters"
                  autoComplete="off"
                  className="ui-input h-10 min-w-[220px] flex-1 font-mono text-[13px]"
                  disabled={busyAction !== null}
                  onChange={(event) => setNewSecretKey(event.target.value)}
                  placeholder="SECRET_KEY"
                  spellCheck={false}
                  value={newSecretKey}
                />
              </div>
              <div>
                <SecretValueTextarea
                  ariaLabel="New variable value"
                  disabled={busyAction !== null}
                  onChange={setNewSecretValue}
                  value={newSecretValue}
                />
              </div>
              <div className="mt-4 flex justify-end border-t border-border pt-4">
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
      </div>

      {selectedProvider === "codex" ? (
        <div className="rounded-[6px] border border-border bg-surface p-4">
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
  onDataChange: OnboardingDataChange;
  onSelectStep: (step: WorkspaceOnboardingStep) => void;
}) {
  const [check, setCheck] = useState(data.setupHealth.latestSandboxCapabilityCheck);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const mountedRef = useRef(true);
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
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
      if (!mountedRef.current) return;
      setCheck(body.check);
      onDataChange((currentData) => updateSandboxCapabilityCheckInData(currentData, body.check));
    } catch (error) {
      if (mountedRef.current) {
        setVerifyError(error instanceof Error ? error.message : "Sandbox capability check failed.");
      }
    } finally {
      if (mountedRef.current) {
        setBusyAction(null);
      }
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
  onInferRepository,
  onRepositoryProfileSaved,
  onSelectStep,
  profileAnalyzing,
  profileDraft,
  profileError,
  profileSaving,
  updateProfileDraft,
}: {
  data: WorkspaceOnboardingData;
  isSaving: boolean;
  onInferRepository: (repository: WorkspaceGitHubRepository) => void;
  onRepositoryProfileSaved: () => void;
  onSelectStep: (step: WorkspaceOnboardingStep) => void;
  profileAnalyzing: boolean;
  profileDraft: EditableProfile | null;
  profileError: string | null;
  profileSaving: boolean;
  updateProfileDraft: (profile: EditableProfile, dirty?: boolean) => void;
}) {
  const selectedRepository = selectedRepositoryFromData(data);

  if (!selectedRepository) {
    return (
      <div className="rounded-[6px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-5 text-muted">
            Select a GitHub repository before analyzing repository setup.
          </p>
          <button className="ui-button" onClick={() => onSelectStep("github")} type="button">
            Open GitHub
          </button>
        </div>
      </div>
    );
  }

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

      <div className="rounded-[6px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-[14px] font-semibold text-foreground">
                {selectedRepository.fullName}
              </h3>
              <Badge tone="accent">Selected</Badge>
              <Badge
                tone={selectedRepository.onboarding.status === "ready" ? "success" : "warning"}
              >
                {selectedRepository.onboarding.status === "ready"
                  ? "Setup ready"
                  : repositorySetupCanAdvance(selectedRepository.onboarding.status)
                    ? "Setup PR open"
                    : "Setup not ready"}
              </Badge>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selectedRepository.defaultProgrammingLanguage ? (
                <span className="ui-pill">{selectedRepository.defaultProgrammingLanguage}</span>
              ) : null}
              {selectedRepository.defaultBranch ? (
                <span className="ui-pill font-mono">{selectedRepository.defaultBranch}</span>
              ) : null}
              <span className="ui-pill">{selectedRepository.isPrivate ? "Private" : "Public"}</span>
            </div>
          </div>

          {!profileDraft && !profileAnalyzing ? (
            <button
              className="ui-button-primary shrink-0"
              disabled={!data.canManage || isSaving}
              onClick={() => onInferRepository(selectedRepository)}
              type="button"
            >
              Analyze repository
            </button>
          ) : null}
        </div>

        {selectedRepository.description ? (
          <p className="mt-3 text-[13px] leading-5 text-muted">{selectedRepository.description}</p>
        ) : null}
      </div>

      {profileDraft ? (
        <RepositoryProfileEditor
          canManage={data.canManage && !isSaving}
          isAnalyzing={profileAnalyzing}
          isSaving={profileSaving}
          onChange={updateProfileDraft}
          onInfer={() => onInferRepository(selectedRepository)}
          onSave={onRepositoryProfileSaved}
          profile={profileDraft}
        />
      ) : profileAnalyzing ? (
        <div className="rounded-[6px] border border-border bg-surface px-3 py-2 text-[13px] text-muted">
          Analyzing repository...
        </div>
      ) : null}
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
  onDataChange: OnboardingDataChange;
  onInferRepository: (repository: WorkspaceGitHubRepository) => void;
  onRefresh: (action: string) => Promise<void>;
  onRepositoryProfileSaved: () => void;
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
        allowManualSetupComplete
        canManage={data.canManage && !isSaving}
        github={data.github}
        hideArchivedRepositories
        onChange={updateGithub}
        onSelectRepository={(repositoryId) => {
          const repository = data.github.repositories.find((item) => item.id === repositoryId);
          if (repository) onSelectGithubRepository(repository);
        }}
        selectedRepositoryId={selectedRepositoryFromData(data)?.id ?? null}
        setupActionScope="selected"
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
        onInferRepository={onInferRepository}
        onRepositoryProfileSaved={onRepositoryProfileSaved}
        onSelectStep={onSelectStep}
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
        onCompleted={onCompleteStep}
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
  canManage,
  items,
  onSelect,
}: {
  canManage: boolean;
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
              (!canManage || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canManage || !step.isNavigable}
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
  canManage,
  items,
  onSelect,
}: {
  canManage: boolean;
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

export function buildRepositoryProfileAutoContinuePatch(
  onboarding: WorkspaceOnboardingData["onboarding"],
): WorkspaceOnboardingUpdatePayload | null {
  if (onboarding.currentStep !== "repository") return null;
  return buildOnboardingContinuePatch(onboarding);
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

function repositorySetupCanAdvance(
  status: WorkspaceOnboardingData["setupHealth"]["repositorySetup"]["status"],
) {
  return status === "pr_open" || status === "ready";
}

function canCompleteGitHubSetupStep(data: WorkspaceOnboardingData) {
  return (
    data.setupHealth.githubInstallation.connected &&
    data.setupHealth.selectedRepository.configured &&
    repositorySetupCanAdvance(data.setupHealth.repositorySetup.status)
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
    (activeStep.id === "pipeline" || activeStep.id === "linear" || activeStep.id === "runtime") &&
    !inlineCompletionUnavailable &&
    !activeStepAlreadyResolved;
  const githubContinueBlocked = activeStep.id === "github" && !canCompleteGitHubSetupStep(data);
  const repositoryContinueBlocked =
    activeStep.id === "repository" && !hasSelectedRepositoryProfile(data);
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

  async function selectGithubRepository(repository: WorkspaceGitHubRepository) {
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
      return;
    }

    const nextData = await persistOnboarding(patch, "repository-selection");
    if (!nextData) return;

    selectedRepositoryIdRef.current = repository.id;
    setSelectedRepositoryId(repository.id);
    setProfileDirty(false);
    setProfileAction(null);
    const selectedRepository = nextData.github.repositories.find(
      (item) => item.id === repository.id,
    );
    setProfileDraft(selectedRepository?.profile ?? null);
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

      <MobileStepControl
        canManage={data.canManage && !isSaving}
        items={railItems}
        onSelect={selectStep}
      />

      <main
        id="main-content"
        className="mx-auto grid w-full max-w-[1180px] flex-1 grid-cols-1 gap-10 px-6 pb-28 sm:px-8 lg:grid-cols-[180px_minmax(0,1fr)_260px] lg:gap-12"
      >
        <aside className="hidden lg:block">
          <div className="sticky top-8">
            <StepRail
              canManage={data.canManage && !isSaving}
              items={railItems}
              onSelect={selectStep}
            />
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
              onDataChange={updateData}
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
