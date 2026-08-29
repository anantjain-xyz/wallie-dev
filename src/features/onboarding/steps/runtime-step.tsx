"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentConfigFieldErrors,
  ApplyAgentConfigDefaultsResponse,
  BatchUpsertAgentConfigErrorResponse,
  BatchUpsertAgentConfigRequest,
  BatchUpsertAgentConfigResponse,
} from "@/app/api/agent-config/route";
import {
  AGENT_CONFIG_VISIBLE_FIELDS,
  AGENT_EFFORT_SELECT_OPTIONS,
  AGENT_PROVIDER_SELECT_OPTIONS,
} from "@/components/shared/agent-provider-options";
import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { XIcon } from "@/components/shared/icons/x-icon";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField, type SelectOption } from "@/components/ui/select";
import { Status } from "@/components/ui/status";
import { Tooltip } from "@/components/ui/tooltip";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import {
  buildRuntimeReadiness,
  configuredAgentConfigKeys,
  resolveAgentConfigValue,
  type AgentConfigMap,
  type RuntimeReadiness,
} from "@/features/onboarding/runtime-readiness";
import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import type { CursorConnectionStatus } from "@/features/settings/cursor-connection-panel";
import { ProviderAccessPanel } from "@/features/settings/provider-access-panel";
import { upsertSecretPreview } from "@/features/settings/secret-previews";
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
  pendingAgentProviderPersistValue,
} from "@/lib/agent-config/drafts";
import type {
  UpsertWorkspaceSecretResponse,
  WorkspaceSecretPreview,
} from "@/lib/secrets/contracts";

import type { OnboardingStepProps } from "./types";

type FieldType = "number" | "select" | "text";

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
    agent_effort: agentConfigValueToDraft(
      "agent_effort",
      resolveAgentConfigValue("agent_effort", agentConfig),
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
    cursorConnection: data.setupHealth.cursorConnection,
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

function updateCursorConnectionInData(
  currentData: WorkspaceOnboardingData,
  status: CursorConnectionStatus,
): WorkspaceOnboardingData {
  return {
    ...currentData,
    setupHealth: {
      ...currentData.setupHealth,
      cursorConnection: {
        accountEmail: status.accountEmail ?? null,
        checkedAt: status.checkedAt,
        connected: status.connected,
        expiresAt: status.expiresAt ?? null,
        reconnectReason: status.reconnectReason ?? null,
        reconnectRequired: status.reconnectRequired ?? false,
        status: status.connected
          ? "connected"
          : status.expired || status.reconnectRequired
            ? "expired"
            : "missing",
        updatedAt: status.updatedAt ?? null,
      },
    },
  };
}

const AGENT_CONFIG_FIELDS: FieldDescriptor[] = [
  {
    configKey: "agent_provider",
    description: AGENT_CONFIG_VISIBLE_FIELDS.agent_provider.description,
    label: AGENT_CONFIG_VISIBLE_FIELDS.agent_provider.label,
    options: AGENT_PROVIDER_SELECT_OPTIONS,
    type: "select",
  },
  {
    configKey: "agent_model",
    description: AGENT_CONFIG_VISIBLE_FIELDS.agent_model.description,
    label: AGENT_CONFIG_VISIBLE_FIELDS.agent_model.label,
    placeholder: RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_model,
    type: "text",
  },
  {
    configKey: "agent_effort",
    description: AGENT_CONFIG_VISIBLE_FIELDS.agent_effort.description,
    label: AGENT_CONFIG_VISIBLE_FIELDS.agent_effort.label,
    options: AGENT_EFFORT_SELECT_OPTIONS,
    type: "select",
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

export default function RuntimeStep({
  data,
  isSaving,
  onDataChange,
  onRuntimeStateChange,
  onSelectStep,
}: OnboardingStepProps) {
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
  const handleCursorStatusChange = useCallback(
    (status: CursorConnectionStatus) =>
      onDataChange((current) => updateCursorConnectionInData(current, status)),
    [onDataChange],
  );
  const selectedDraftProvider = normalizeAgentProviderName(drafts.agent_provider) ?? "codex";
  const [cursorModels, setCursorModels] = useState<SelectOption[]>([]);
  useEffect(() => {
    if (selectedDraftProvider !== "cursor" || !data.setupHealth.cursorConnection?.connected) return;
    const controller = new AbortController();
    void fetch("/api/cursor/models", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as { models?: SelectOption[] };
        if (response.ok) setCursorModels(payload.models ?? []);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [data.setupHealth.cursorConnection?.connected, selectedDraftProvider]);
  const fields = useMemo(
    () =>
      AGENT_CONFIG_FIELDS.map((field) =>
        field.configKey === "agent_model" &&
        selectedDraftProvider === "cursor" &&
        cursorModels.length > 0
          ? ({ ...field, options: cursorModels, type: "select" } satisfies FieldDescriptor)
          : field,
      ),
    [cursorModels, selectedDraftProvider],
  );
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
      status.field.configKey === "agent_provider" ||
      status.field.configKey === "agent_model" ||
      status.field.configKey === "agent_effort",
  );
  const executionFieldStatuses = fieldStatuses.filter(
    (status) =>
      status.field.configKey !== "agent_provider" &&
      status.field.configKey !== "agent_model" &&
      status.field.configKey !== "agent_effort",
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
  const sandboxConnectionHref = "#sandbox";
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
      const pendingProvider = pendingAgentProviderPersistValue(
        data.agentConfig.agent_provider,
        drafts.agent_provider,
      );
      if (pendingProvider !== undefined) {
        config.agent_provider = pendingProvider;
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
              <ActionButtonLabel
                idle="Save config"
                pending={busyAction === "config"}
                pendingLabel="Saving…"
              />
            </button>
          </div>
        </div>

        <div className="mt-4" data-sandbox-connection-href={sandboxConnectionHref}>
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
            initialCursorStatus={
              data.setupHealth.cursorConnection
                ? {
                    accountEmail: data.setupHealth.cursorConnection.accountEmail,
                    checkedAt: data.setupHealth.cursorConnection.checkedAt,
                    connected: data.setupHealth.cursorConnection.connected,
                    expired: data.setupHealth.cursorConnection.status === "expired",
                    expiresAt: data.setupHealth.cursorConnection.expiresAt,
                    reconnectReason: data.setupHealth.cursorConnection.reconnectReason,
                    reconnectRequired: data.setupHealth.cursorConnection.reconnectRequired,
                    updatedAt: data.setupHealth.cursorConnection.updatedAt,
                  }
                : undefined
            }
            onClaudeCodeStatusChange={handleClaudeCodeStatusChange}
            onCodexStatusChange={handleCodexStatusChange}
            onCursorStatusChange={handleCursorStatusChange}
            onSandboxConnectionSelect={() => onSelectStep("sandbox")}
            provider={selectedProvider}
            returnTo={`/w/${data.workspace.slug}/onboarding?step=runtime`}
            sandboxConnectionHref={sandboxConnectionHref}
            sandboxConnectionLabel={
              data.setupHealth.sandboxConnection?.providerLabel ?? "a sandbox provider"
            }
            sandboxConnectionReady={
              data.setupHealth.sandboxConnection?.connected ??
              data.setupHealth.vercelSandboxConnection.connected
            }
            vercelConnectionHref="#sandbox"
            vercelSandboxConnection={data.vercelSandboxConnection}
            variant="embedded"
            workspaceId={data.workspace.id}
          />
        </div>
      </div>

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
                    <Tooltip content="Remove row">
                      <button
                        aria-label="Remove variable row"
                        className="ui-button h-10 w-10 shrink-0 !px-0 !py-0"
                        disabled={busyAction !== null}
                        onClick={() => handleRemoveNewSecretRow(row.id)}
                        type="button"
                      >
                        <XIcon className="h-4 w-4" />
                      </button>
                    </Tooltip>
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
                <ActionButtonLabel
                  idle="Save config"
                  pending={busyAction === "repository-config"}
                  pendingLabel="Saving…"
                />
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
