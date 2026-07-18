"use client";

import type { ReactNode } from "react";
import { useMemo, useRef, useState } from "react";

import type {
  AgentConfigEntry,
  AgentConfigFieldErrors,
  BatchUpsertAgentConfigErrorResponse,
  BatchUpsertAgentConfigRequest,
  BatchUpsertAgentConfigResponse,
} from "@/app/api/agent-config/route";
import {
  AGENT_PROVIDER_EMPTY_OPTION,
  AGENT_PROVIDER_SELECT_OPTIONS,
} from "@/components/shared/agent-provider-options";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField, type SelectOption } from "@/components/ui/select";
import type { AgentConfigMap } from "@/features/settings/data";
import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import { ProviderAccessPanel } from "@/features/settings/provider-access-panel";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import {
  type AgentConfigKey,
  type AgentProvider,
  AGENT_CONFIG_LIMITS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  STALL_TIMEOUT_MINUTE_LIMITS,
  getRecommendedAgentModel,
  normalizeAgentProviderName,
} from "@/lib/agent-config/contracts";
import {
  agentConfigValueToDraft,
  applyAgentConfigDraftChange,
  parseAgentConfigDraft,
} from "@/lib/agent-config/drafts";
import type { VercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/contracts";

type AgentConfigSectionProps = {
  anchorId?: string;
  canManage: boolean;
  codexConnectFlash?: string | null;
  extraContent?: ReactNode;
  initialAgentConfig: AgentConfigMap;
  initialClaudeCodeStatus?: ClaudeCodeConnectionStatus;
  initialCodexStatus?: CodexConnectionStatus;
  onAgentConfigSaved?: (entries: AgentConfigEntry[]) => void;
  onClaudeCodeStatusChange?: (status: ClaudeCodeConnectionStatus) => void;
  onCodexStatusChange?: (status: CodexConnectionStatus) => void;
  setFlashMessage: (message: FlashMessage) => void;
  tagline?: ReactNode;
  title?: string;
  vercelSandboxConnection?: VercelSandboxConnectionPreview | null;
  workspaceId: string;
};

type FieldType = "number" | "select" | "text";

type FieldDescriptor = {
  configKey: AgentConfigKey;
  description: string;
  label: string;
  options?: readonly SelectOption[];
  placeholder?: string;
  type: FieldType;
};

function AgentConfigField({
  description,
  disabled,
  draft,
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
          emptyOption={AGENT_PROVIDER_EMPTY_OPTION}
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
  initialAgentConfig,
  initialClaudeCodeStatus,
  initialCodexStatus,
  onAgentConfigSaved,
  onClaudeCodeStatusChange,
  onCodexStatusChange,
  setFlashMessage,
  tagline = "Configure how Wallie runs coding agents in this workspace. These settings apply to all sessions that trigger agent execution.",
  title = "Coding agent",
  vercelSandboxConnection,
  workspaceId,
}: AgentConfigSectionProps) {
  const [agentConfig, setAgentConfig] = useState<AgentConfigMap>(initialAgentConfig);
  const [drafts, setDrafts] = useState<Record<AgentConfigKey, string>>(() => ({
    agent_provider: agentConfigValueToDraft("agent_provider", initialAgentConfig.agent_provider),
    agent_model: agentConfigValueToDraft("agent_model", initialAgentConfig.agent_model),
    concurrency_limit: agentConfigValueToDraft(
      "concurrency_limit",
      initialAgentConfig.concurrency_limit,
    ),
    stall_timeout_ms: agentConfigValueToDraft(
      "stall_timeout_ms",
      initialAgentConfig.stall_timeout_ms,
    ),
    max_retries: agentConfigValueToDraft("max_retries", initialAgentConfig.max_retries),
  }));
  const [isSaving, setIsSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const [serverFieldErrors, setServerFieldErrors] = useState<AgentConfigFieldErrors>({});

  const selectedAgentProvider: AgentProvider =
    normalizeAgentProviderName(drafts.agent_provider) ?? "codex";

  const fields: FieldDescriptor[] = useMemo(
    () => [
      {
        configKey: "agent_provider",
        description: "Which agent CLI to use for coding tasks.",
        label: "Agent provider",
        options: AGENT_PROVIDER_SELECT_OPTIONS,
        type: "select",
      },
      {
        configKey: "agent_model",
        description: "Model identifier passed to the selected agent provider.",
        label: "Agent model",
        placeholder: getRecommendedAgentModel(selectedAgentProvider),
        type: "text",
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
        configKey: "max_retries",
        description: `Maximum automatic retries for failed agent runs (${AGENT_CONFIG_LIMITS.max_retries.min}–${AGENT_CONFIG_LIMITS.max_retries.max}).`,
        label: "Max retries",
        placeholder: "3",
        type: "number",
      },
    ],
    [selectedAgentProvider],
  );

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
      status.field.configKey === "agent_provider" || status.field.configKey === "agent_model",
  );
  const executionFieldStatuses = fieldStatuses.filter(
    (status) =>
      status.field.configKey !== "agent_provider" && status.field.configKey !== "agent_model",
  );

  const hasErrors = fieldStatuses.some((status) => status.validationError !== null);
  const dirtyFields = fieldStatuses.filter((status) => status.isDirty);
  const saveableFields = dirtyFields.filter((status) => status.validation?.ok === true);
  const canSave = !isSaving && saveableFields.length > 0 && !hasErrors;

  function handleFieldChange(key: AgentConfigKey, next: string) {
    setDrafts((current) => applyAgentConfigDraftChange(current, key, next));
    setServerFieldErrors((current) => {
      if (!current[key]) return current;
      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  }

  async function handleSaveAll() {
    if (saveInFlightRef.current || saveableFields.length === 0) return;
    saveInFlightRef.current = true;
    setIsSaving(true);
    setServerFieldErrors({});

    const config: BatchUpsertAgentConfigRequest["config"] = {};
    for (const status of saveableFields) {
      if (status.validation?.ok) {
        config[status.field.configKey] = status.validation.value;
      }
    }

    try {
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

  return (
    <Section anchorId={anchorId} tagline={tagline} title={title}>
      {canManage ? (
        <div className="space-y-6">
          <div className="space-y-6">
            {providerFieldStatuses.map((status) => (
              <AgentConfigField
                key={status.field.configKey}
                description={status.field.description}
                disabled={isSaving}
                draft={status.draft}
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
            onClaudeCodeStatusChange={onClaudeCodeStatusChange}
            onCodexStatusChange={onCodexStatusChange}
            provider={selectedAgentProvider}
            vercelSandboxConnection={vercelSandboxConnection}
            workspaceId={workspaceId}
          />

          <div className="space-y-6">
            {executionFieldStatuses.map((status) => (
              <AgentConfigField
                key={status.field.configKey}
                description={status.field.description}
                disabled={isSaving}
                draft={status.draft}
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
              <ActionButtonLabel idle="Save changes" pending={isSaving} pendingLabel="Saving…" />
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
            onClaudeCodeStatusChange={onClaudeCodeStatusChange}
            onCodexStatusChange={onCodexStatusChange}
            provider={selectedAgentProvider}
            vercelSandboxConnection={vercelSandboxConnection}
            workspaceId={workspaceId}
          />
          {extraContent}
        </div>
      )}
    </Section>
  );
}
