"use client";

import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import type { UpsertAgentConfigResponse } from "@/app/api/agent-config/route";
import {
  AGENT_PROVIDER_EMPTY_OPTION,
  AGENT_PROVIDER_SELECT_OPTIONS,
} from "@/components/shared/agent-provider-options";
import { SelectField, type SelectOption } from "@/components/ui/select";
import type { AgentConfigMap } from "@/features/settings/data";
import type { ClaudeCodeConnectionStatus } from "@/features/settings/claude-code-connection-panel";
import type { CodexConnectionStatus } from "@/features/settings/codex-connection-panel";
import { ProviderAccessPanel } from "@/features/settings/provider-access-panel";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
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
  onAgentConfigSaved?: (entry: UpsertAgentConfigResponse["entry"]) => void;
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
        <p className="text-[12px] leading-5 text-danger" role="alert">
          {error}
        </p>
      ) : (
        <p className="text-[12px] leading-5 text-muted">{description}</p>
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

  const saveAgentConfig = useApiAction<UpsertAgentConfigResponse, [AgentConfigKey, unknown], true>({
    call: (key, value) =>
      fetch("/api/agent-config", {
        body: JSON.stringify({
          key,
          value,
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    errorText: "Agent config save failed.",
    onSuccess: (payload) => {
      setAgentConfig((current) => ({ ...current, [payload.entry.key]: payload.entry.value }));
      onAgentConfigSaved?.(payload.entry);
      return true;
    },
    setFlashMessage,
    successText: null,
  });

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
    const validationError = validation && !validation.ok ? validation.error : null;
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
  const canSave = !saveAgentConfig.isBusy && saveableFields.length > 0 && !hasErrors;

  function handleFieldChange(key: AgentConfigKey, next: string) {
    setDrafts((current) => applyAgentConfigDraftChange(current, key, next));
  }

  async function handleSaveAll() {
    if (saveableFields.length === 0) return;

    let successCount = 0;
    for (const status of saveableFields) {
      if (!status.validation || !status.validation.ok) continue;
      const result = await saveAgentConfig.run(status.field.configKey, status.validation.value);
      if (result === true) successCount++;
    }

    if (successCount === saveableFields.length) {
      setFlashMessage({
        kind: "success",
        text: "Saved.",
      });
    } else if (successCount > 0) {
      setFlashMessage({
        kind: "error",
        text: `Saved ${successCount} of ${saveableFields.length} agent settings — see errors above.`,
      });
    }
    // If successCount === 0, useApiAction already surfaced the per-call error flash.
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
                disabled={saveAgentConfig.isBusy}
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
                disabled={saveAgentConfig.isBusy}
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
            <p className="text-[12px] text-muted">
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
              {saveAgentConfig.isBusy ? "Saving…" : "Save changes"}
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
