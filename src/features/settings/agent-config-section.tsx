"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentConfigEntry,
  AgentConfigFieldErrors,
  BatchUpsertAgentConfigErrorResponse,
  BatchUpsertAgentConfigRequest,
  BatchUpsertAgentConfigResponse,
} from "@/app/api/agent-config/route";
import {
  AGENT_CONFIG_VISIBLE_FIELDS,
  AGENT_EFFORT_EMPTY_OPTION,
  AGENT_EFFORT_SELECT_OPTIONS,
  AGENT_PROVIDER_SELECT_OPTIONS,
} from "@/components/shared/agent-provider-options";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField, type SelectOption } from "@/components/ui/select";
import { Status } from "@/components/ui/status";
import type { AgentConfigMap } from "@/features/settings/data";
import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import type { CursorConnectionStatus } from "@/features/settings/cursor-connection-panel";
import {
  reloadSettingsFactoryDefinition,
  saveSettingsFactoryDraft,
  useFactoryDefinitionReloadListener,
  useFactoryDefinitionStore,
  type SettingsFactoryReloadPayload,
} from "@/features/settings/factory-definition-store";
import type { OpenCodeConnectionStatus } from "@/features/settings/opencode-connection-panel";
import { ProviderAccessPanel } from "@/features/settings/provider-access-panel";
import {
  dispatchSettingsDataChanged,
  dispatchSettingsEvent,
  SETTINGS_PIPELINE_CHANGED,
} from "@/features/settings/settings-island-events";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import {
  type AgentConfigKey,
  type AgentEffort,
  type AgentProvider,
  AGENT_CONFIG_LIMITS,
  ALLOWED_AGENT_CONFIG_KEYS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  STALL_TIMEOUT_MINUTE_LIMITS,
  agentProviderSupportsEffort,
  getRecommendedAgentModel,
  normalizeAgentProviderName,
} from "@/lib/agent-config/contracts";
import {
  agentConfigValueToDraft,
  applyAgentConfigDraftChange,
  parseAgentConfigDraft,
  pendingAgentProviderPersistValue,
} from "@/lib/agent-config/drafts";
import { discoverCursorModels } from "@/lib/cursor/client";
import {
  canRouteSettingsThroughFactoryDraft,
  type SettingsFactoryDefinitionState,
} from "@/lib/factory-definitions/settings-contracts";
import {
  agentConfigFromFactoryDefinition,
  mapCompilerDiagnosticsToAgentFieldErrors,
  projectSettingsDataWithFactoryDefinition,
} from "@/lib/factory-definitions/settings-projection";

type AgentConfigSectionProps = {
  anchorId?: string;
  canManage: boolean;
  codexConnectFlash?: string | null;
  extraContent?: ReactNode;
  factoryDefinition?: SettingsFactoryDefinitionState;
  initialAgentConfig: AgentConfigMap;
  initialClaudeCodeStatus?: ClaudeCodeConnectionStatus;
  initialCodexStatus?: CodexConnectionStatus;
  initialCursorStatus?: CursorConnectionStatus;
  initialOpenCodeStatus?: OpenCodeConnectionStatus;
  onAgentConfigSaved?: (entries: AgentConfigEntry[]) => void;
  onClaudeCodeStatusChange?: (status: ClaudeCodeConnectionStatus) => void;
  onCodexStatusChange?: (status: CodexConnectionStatus) => void;
  onCursorStatusChange?: (status: CursorConnectionStatus) => void;
  onOpenCodeStatusChange?: (status: OpenCodeConnectionStatus) => void;
  sandboxConnectionHref?: string;
  sandboxConnectionLabel?: string;
  sandboxConnectionReady?: boolean;
  setFlashMessage: (message: FlashMessage) => void;
  tagline?: ReactNode;
  title?: string;
  workspaceId: string;
};

type FieldType = "number" | "select" | "text";

type FieldDescriptor = {
  configKey: AgentConfigKey;
  description: string;
  emptyOption?: SelectOption;
  label: string;
  options?: readonly SelectOption[];
  placeholder?: string;
  type: FieldType;
};

function AgentConfigField({
  description,
  disabled,
  draft,
  emptyOption,
  error,
  label,
  onChange,
  options,
  placeholder,
  trailing,
  type,
}: {
  description: string;
  disabled: boolean;
  draft: string;
  emptyOption?: SelectOption;
  error: string | null;
  label: string;
  onChange: (next: string) => void;
  options?: readonly SelectOption[];
  placeholder?: string;
  trailing?: React.ReactNode;
  type: FieldType;
}) {
  return (
    <div className="space-y-1.5">
      {type === "select" && options ? (
        <SelectField
          disabled={disabled}
          emptyOption={emptyOption}
          label={label}
          onValueChange={onChange}
          options={options}
          value={draft}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-foreground">{label}</span>
            {trailing}
          </div>
          <input
            aria-label={label}
            autoComplete="off"
            className="ui-input"
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            type={type === "number" ? "number" : "text"}
            value={draft}
          />
        </>
      )}
      {error ? (
        <p className="text-xs leading-5 text-danger" role="alert">
          {error}
        </p>
      ) : (
        <p className="text-xs leading-5 text-muted">{description}</p>
      )}
    </div>
  );
}

export function AgentConfigSection({
  anchorId = "coding-agent",
  canManage,
  codexConnectFlash,
  extraContent,
  factoryDefinition,
  initialAgentConfig,
  initialClaudeCodeStatus,
  initialCodexStatus,
  initialCursorStatus,
  initialOpenCodeStatus,
  onAgentConfigSaved,
  onClaudeCodeStatusChange,
  onCodexStatusChange,
  onCursorStatusChange,
  onOpenCodeStatusChange,
  sandboxConnectionHref,
  sandboxConnectionLabel,
  sandboxConnectionReady,
  setFlashMessage,
  tagline = "Configure agents for all workspace sessions.",
  title = "Coding agent",
  workspaceId,
}: AgentConfigSectionProps) {
  const {
    conflict: factoryConflict,
    setDirty: setFactorySectionDirty,
    state: factoryState,
  } = useFactoryDefinitionStore(workspaceId, factoryDefinition);
  const factoryRouted =
    Boolean(factoryDefinition) && canRouteSettingsThroughFactoryDraft(factoryState);

  const [agentConfig, setAgentConfig] = useState<AgentConfigMap>(initialAgentConfig);
  const [drafts, setDrafts] = useState<Record<AgentConfigKey, string>>(() => ({
    agent_provider: agentConfigValueToDraft("agent_provider", initialAgentConfig.agent_provider),
    agent_model: agentConfigValueToDraft("agent_model", initialAgentConfig.agent_model),
    agent_effort: agentConfigValueToDraft("agent_effort", initialAgentConfig.agent_effort),
    concurrency_limit: agentConfigValueToDraft(
      "concurrency_limit",
      initialAgentConfig.concurrency_limit,
    ),
    stall_timeout_ms: agentConfigValueToDraft(
      "stall_timeout_ms",
      initialAgentConfig.stall_timeout_ms,
    ),
    max_retries: agentConfigValueToDraft("max_retries", initialAgentConfig.max_retries),
    max_turns: agentConfigValueToDraft("max_turns", initialAgentConfig.max_turns),
  }));
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [localConflict, setLocalConflict] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const [serverFieldErrors, setServerFieldErrors] = useState<AgentConfigFieldErrors>({});
  const [cursorModels, setCursorModels] = useState<SelectOption[]>([]);
  const [cursorConnected, setCursorConnected] = useState(initialCursorStatus?.connected ?? false);

  const selectedAgentProvider: AgentProvider =
    normalizeAgentProviderName(drafts.agent_provider) ?? "codex";

  useEffect(() => {
    if (selectedAgentProvider !== "cursor" || !cursorConnected) return;
    const controller = new AbortController();
    void discoverCursorModels(controller.signal)
      .then(({ connectionStatus, models }) => {
        setCursorModels(models);
        if (connectionStatus) {
          setCursorConnected(connectionStatus.connected);
          onCursorStatusChange?.(connectionStatus);
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [cursorConnected, onCursorStatusChange, selectedAgentProvider]);

  const fields: FieldDescriptor[] = useMemo(() => {
    const allFields: FieldDescriptor[] = [
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
        placeholder: getRecommendedAgentModel(selectedAgentProvider),
        options:
          selectedAgentProvider === "cursor" && cursorModels.length > 0 ? cursorModels : undefined,
        type: selectedAgentProvider === "cursor" && cursorModels.length > 0 ? "select" : "text",
      },
      {
        configKey: "agent_effort",
        description: AGENT_CONFIG_VISIBLE_FIELDS.agent_effort.description,
        emptyOption: AGENT_EFFORT_EMPTY_OPTION,
        label: AGENT_CONFIG_VISIBLE_FIELDS.agent_effort.label,
        options: AGENT_EFFORT_SELECT_OPTIONS,
        type: "select",
      },
      {
        configKey: "concurrency_limit",
        description: `Max number of agent jobs that can run simultaneously (${AGENT_CONFIG_LIMITS.concurrency_limit.min}–${AGENT_CONFIG_LIMITS.concurrency_limit.max}).`,
        label: "Concurrency limit",
        placeholder: "1",
        type: "number",
      },
      {
        configKey: "stall_timeout_ms",
        description: `Time in minutes before a run with no activity is considered stalled (${STALL_TIMEOUT_MINUTE_LIMITS.min}–${STALL_TIMEOUT_MINUTE_LIMITS.max} minutes).`,
        label: "Stall timeout (minutes)",
        placeholder: agentConfigValueToDraft(
          "stall_timeout_ms",
          RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms,
        ),
        type: "number",
      },
      {
        configKey: "max_turns",
        description: "Maximum Claude Code turns per run (1–100). Defaults to 5.",
        label: "Max turns",
        placeholder: "5",
        type: "number",
      },
      {
        configKey: "max_retries",
        description: `Maximum automatic retries for failed agent runs (${AGENT_CONFIG_LIMITS.max_retries.min}–${AGENT_CONFIG_LIMITS.max_retries.max}).`,
        label: "Max retries",
        placeholder: "3",
        type: "number",
      },
    ];

    return allFields.filter(
      (field) =>
        (field.configKey !== "agent_effort" ||
          agentProviderSupportsEffort(selectedAgentProvider)) &&
        (field.configKey !== "max_turns" || selectedAgentProvider === "claude-code"),
    );
  }, [cursorModels, selectedAgentProvider]);

  const fieldStatuses = fields.map((field) => {
    const draft = drafts[field.configKey];
    const currentValue = agentConfigValueToDraft(field.configKey, agentConfig[field.configKey]);
    const isDirty = draft !== currentValue;
    const draftIsEmpty = draft.trim() === "";
    const validation = draftIsEmpty
      ? null
      : parseAgentConfigDraft(field.configKey, field.type, draft);
    const validationError =
      (isDirty && draftIsEmpty
        ? `${field.label} is required.`
        : validation && !validation.ok
          ? validation.error
          : null) ??
      serverFieldErrors[field.configKey] ??
      null;
    return { field, draft, isDirty, validation, validationError };
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

  const hasErrors = fieldStatuses.some((status) => status.validationError !== null);
  const dirtyFields = fieldStatuses.filter((status) => status.isDirty);
  const saveableFields = dirtyFields.filter((status) => status.validation?.ok === true);
  const conflictMessage = factoryRouted ? (localConflict ?? factoryConflict) : null;
  const hasConflict = Boolean(conflictMessage);
  const canSave =
    !isSaving && !isReloading && !hasConflict && saveableFields.length > 0 && !hasErrors;

  useEffect(() => {
    if (factoryRouted) {
      setFactorySectionDirty("agent", dirtyFields.length > 0);
    }
  }, [dirtyFields.length, factoryRouted, setFactorySectionDirty]);

  const handleFactoryReload = useCallback(
    (payload: SettingsFactoryReloadPayload) => {
      const nextConfig =
        payload.agentConfig ??
        (payload.state.activeDefinition
          ? agentConfigFromFactoryDefinition(payload.state.activeDefinition)
          : initialAgentConfig);
      setAgentConfig(nextConfig);
      setDrafts({
        agent_provider: agentConfigValueToDraft("agent_provider", nextConfig.agent_provider),
        agent_model: agentConfigValueToDraft("agent_model", nextConfig.agent_model),
        agent_effort: agentConfigValueToDraft("agent_effort", nextConfig.agent_effort),
        concurrency_limit: agentConfigValueToDraft(
          "concurrency_limit",
          nextConfig.concurrency_limit,
        ),
        stall_timeout_ms: agentConfigValueToDraft("stall_timeout_ms", nextConfig.stall_timeout_ms),
        max_retries: agentConfigValueToDraft("max_retries", nextConfig.max_retries),
        max_turns: agentConfigValueToDraft("max_turns", nextConfig.max_turns),
      });
      setLocalConflict(null);
      setServerFieldErrors({});
    },
    [initialAgentConfig],
  );

  useFactoryDefinitionReloadListener(workspaceId, factoryRouted, handleFactoryReload);

  function handleFieldChange(key: AgentConfigKey, next: string) {
    setDrafts((current) => applyAgentConfigDraftChange(current, key, next));
    setServerFieldErrors((current) => {
      if (!current[key]) return current;
      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  }

  async function handleReloadDefinition() {
    if (isReloading || isSaving) return;
    setIsReloading(true);
    try {
      const result = await reloadSettingsFactoryDefinition(workspaceId, factoryState);
      if (!result.ok) {
        setFlashMessage({ kind: "error", text: result.error });
        return;
      }
      if (result.data.pipeline) {
        dispatchSettingsEvent(SETTINGS_PIPELINE_CHANGED, result.data.pipeline);
      }
      dispatchSettingsDataChanged(workspaceId, (current) => ({
        ...projectSettingsDataWithFactoryDefinition(current, result.data.state),
        ...(result.data.pipeline ? { pipeline: result.data.pipeline } : {}),
      }));
      setFlashMessage({ kind: "info", text: "Reloaded saved factory definition." });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not reload factory definition state.",
      });
    } finally {
      setIsReloading(false);
    }
  }

  async function handleSaveAll() {
    if (saveInFlightRef.current || saveableFields.length === 0 || hasConflict) return;
    saveInFlightRef.current = true;
    setIsSaving(true);
    setServerFieldErrors({});

    const config: BatchUpsertAgentConfigRequest["config"] = {};
    for (const status of saveableFields) {
      if (status.validation?.ok) {
        config[status.field.configKey] = status.validation.value;
      }
    }
    const pendingProvider = pendingAgentProviderPersistValue(
      agentConfig.agent_provider,
      drafts.agent_provider,
    );
    if (pendingProvider !== undefined) {
      config.agent_provider = pendingProvider;
    }

    try {
      if (factoryRouted) {
        const valueFor = (key: AgentConfigKey, fallback: string | number) => {
          if (key in config && config[key] !== undefined) return config[key];
          const parsed = parseAgentConfigDraft(
            key,
            key === "concurrency_limit" ||
              key === "stall_timeout_ms" ||
              key === "max_retries" ||
              key === "max_turns"
              ? "number"
              : key === "agent_model"
                ? "text"
                : "select",
            drafts[key],
          );
          if (parsed.ok) return parsed.value;
          return agentConfig[key] ?? fallback;
        };

        const rawEffort = drafts.agent_effort.trim();
        const resolvedEffort: AgentEffort | null = agentProviderSupportsEffort(
          selectedAgentProvider,
        )
          ? rawEffort
            ? (String(
                valueFor("agent_effort", RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_effort),
              ) as AgentEffort)
            : null
          : null;

        const result = await saveSettingsFactoryDraft(
          workspaceId,
          {
            kind: "agent",
            agent: {
              provider: selectedAgentProvider,
              model: String(
                valueFor("agent_model", getRecommendedAgentModel(selectedAgentProvider)),
              ),
              effort: resolvedEffort,
              concurrencyLimit: Number(
                valueFor("concurrency_limit", RECOMMENDED_AGENT_CONFIG_DEFAULTS.concurrency_limit),
              ),
              stallTimeoutMs: Number(
                valueFor("stall_timeout_ms", RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms),
              ),
              maxRetries: Number(
                valueFor("max_retries", RECOMMENDED_AGENT_CONFIG_DEFAULTS.max_retries),
              ),
              maxTurns: Number(valueFor("max_turns", RECOMMENDED_AGENT_CONFIG_DEFAULTS.max_turns)),
            },
          },
          factoryState,
        );

        if (!result.ok) {
          if (result.status === 409) {
            setLocalConflict(result.error);
            return;
          }
          const mappedErrors = {
            ...mapCompilerDiagnosticsToAgentFieldErrors(result.diagnostics),
            ...(result.fieldErrors as AgentConfigFieldErrors | undefined),
          };
          if (Object.keys(mappedErrors).length > 0) {
            setServerFieldErrors(mappedErrors);
          }
          throw new Error(result.diagnostics?.[0]?.message ?? result.error);
        }

        const nextConfig =
          result.data.agentConfig ??
          (result.data.state.activeDefinition
            ? agentConfigFromFactoryDefinition(result.data.state.activeDefinition)
            : agentConfig);
        const entries = ALLOWED_AGENT_CONFIG_KEYS.filter(
          (key) => nextConfig[key] !== undefined,
        ).map((key) => ({ key, value: nextConfig[key] }));

        setAgentConfig(nextConfig);
        setDrafts({
          agent_provider: agentConfigValueToDraft("agent_provider", nextConfig.agent_provider),
          agent_model: agentConfigValueToDraft("agent_model", nextConfig.agent_model),
          agent_effort: agentConfigValueToDraft("agent_effort", nextConfig.agent_effort),
          concurrency_limit: agentConfigValueToDraft(
            "concurrency_limit",
            nextConfig.concurrency_limit,
          ),
          stall_timeout_ms: agentConfigValueToDraft(
            "stall_timeout_ms",
            nextConfig.stall_timeout_ms,
          ),
          max_retries: agentConfigValueToDraft("max_retries", nextConfig.max_retries),
          max_turns: agentConfigValueToDraft("max_turns", nextConfig.max_turns),
        });
        setLocalConflict(null);
        onAgentConfigSaved?.(entries);
        setFlashMessage({
          kind: "success",
          text: "Agent settings saved to draft. Publish draft to apply to new sessions.",
        });
        return;
      }

      const response = await fetch("/api/agent-config", {
        body: JSON.stringify({ config, workspaceId } satisfies BatchUpsertAgentConfigRequest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as
        | BatchUpsertAgentConfigErrorResponse
        | BatchUpsertAgentConfigResponse
        | null;
      if (!response.ok || !payload || !("entries" in payload)) {
        if (payload && "fieldErrors" in payload) {
          setServerFieldErrors(payload.fieldErrors ?? {});
        }
        throw new Error(
          payload && "error" in payload ? payload.error : "Agent config save failed.",
        );
      }

      setAgentConfig((current) => {
        const next = { ...current };
        for (const entry of payload.entries) {
          next[entry.key] = entry.value;
        }
        return next;
      });
      setDrafts((current) => {
        const next = { ...current };
        for (const entry of payload.entries) {
          next[entry.key] = agentConfigValueToDraft(entry.key, entry.value);
        }
        return next;
      });
      onAgentConfigSaved?.(payload.entries);
      setFlashMessage({
        kind: "success",
        text: "Saved.",
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Agent config save failed.",
      });
    } finally {
      saveInFlightRef.current = false;
      setIsSaving(false);
    }
  }

  const draftHasAgentChanges =
    factoryRouted &&
    Boolean(factoryState.latestDraft) &&
    JSON.stringify(factoryState.latestDraft?.definition.agent) !==
      JSON.stringify(factoryState.currentActivation?.definition.agent);

  const statusBadge = !factoryRouted ? null : dirtyFields.length > 0 ? (
    <Status label="Unsaved changes" value="needs_attention" />
  ) : hasConflict ? (
    <Status label="Conflict" value="blocked" />
  ) : draftHasAgentChanges ? (
    <Status label="Draft saved" value="in_progress" />
  ) : factoryState.currentActivation ? (
    <Status
      label={`Published #${factoryState.currentActivation.activationNumber}`}
      value="healthy"
    />
  ) : null;

  return (
    <Section anchorId={anchorId} statusBadge={statusBadge} tagline={tagline} title={title}>
      {canManage ? (
        <div className="space-y-6">
          {conflictMessage ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
              role="alert"
            >
              <p>{conflictMessage}</p>
              <button
                className="ui-button shrink-0"
                disabled={isSaving || isReloading}
                onClick={() => void handleReloadDefinition()}
                type="button"
              >
                {isReloading ? "Reloading…" : "Reload saved definition"}
              </button>
            </div>
          ) : null}
          <div className="space-y-6">
            {providerFieldStatuses.map((status) => (
              <AgentConfigField
                key={status.field.configKey}
                description={status.field.description}
                disabled={isSaving}
                draft={status.draft}
                emptyOption={status.field.emptyOption}
                error={status.validationError}
                label={status.field.label}
                onChange={(next) => handleFieldChange(status.field.configKey, next)}
                options={status.field.options}
                placeholder={status.field.placeholder}
                type={status.field.type}
              />
            ))}
          </div>

          <ProviderAccessPanel
            connectFlash={codexConnectFlash}
            initialClaudeCodeStatus={initialClaudeCodeStatus}
            initialCodexStatus={initialCodexStatus}
            initialCursorStatus={initialCursorStatus}
            initialOpenCodeStatus={initialOpenCodeStatus}
            onClaudeCodeStatusChange={onClaudeCodeStatusChange}
            onCodexStatusChange={onCodexStatusChange}
            onCursorStatusChange={(status) => {
              setCursorConnected(status.connected);
              onCursorStatusChange?.(status);
            }}
            onOpenCodeStatusChange={onOpenCodeStatusChange}
            provider={selectedAgentProvider}
            sandboxConnectionHref={sandboxConnectionHref}
            sandboxConnectionLabel={sandboxConnectionLabel}
            sandboxConnectionReady={sandboxConnectionReady}
            workspaceId={workspaceId}
          />

          <div className="space-y-6">
            {executionFieldStatuses.map((status) => (
              <AgentConfigField
                key={status.field.configKey}
                description={status.field.description}
                disabled={isSaving}
                draft={status.draft}
                emptyOption={status.field.emptyOption}
                error={status.validationError}
                label={status.field.label}
                onChange={(next) => handleFieldChange(status.field.configKey, next)}
                options={status.field.options}
                placeholder={status.field.placeholder}
                type={status.field.type}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-muted">
              {dirtyFields.length === 0
                ? "No unsaved changes."
                : `${dirtyFields.length} unsaved change${dirtyFields.length === 1 ? "" : "s"}.`}
            </p>
            <button
              className="ui-button-primary"
              disabled={!canSave}
              onClick={() => void handleSaveAll()}
              type="button"
            >
              <ActionButtonLabel
                idle={factoryRouted ? "Save draft" : "Save changes"}
                pending={isSaving}
                pendingLabel="Saving…"
              />
            </button>
          </div>

          {extraContent}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] leading-6 text-muted">
            Workspace admins can configure coding agent settings from this page.
          </p>
          <ProviderAccessPanel
            connectFlash={codexConnectFlash}
            initialClaudeCodeStatus={initialClaudeCodeStatus}
            initialCodexStatus={initialCodexStatus}
            initialCursorStatus={initialCursorStatus}
            initialOpenCodeStatus={initialOpenCodeStatus}
            onClaudeCodeStatusChange={onClaudeCodeStatusChange}
            onCodexStatusChange={onCodexStatusChange}
            onCursorStatusChange={(status) => {
              setCursorConnected(status.connected);
              onCursorStatusChange?.(status);
            }}
            onOpenCodeStatusChange={onOpenCodeStatusChange}
            provider={selectedAgentProvider}
            sandboxConnectionHref={sandboxConnectionHref}
            sandboxConnectionLabel={sandboxConnectionLabel}
            sandboxConnectionReady={sandboxConnectionReady}
            workspaceId={workspaceId}
          />
          {extraContent}
        </div>
      )}
    </Section>
  );
}
