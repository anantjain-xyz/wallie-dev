"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

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
import type { AgentConfigMap } from "@/features/settings/data";
import {
  FactorySettingsFormConflict,
  useFactorySettingsForm,
} from "@/features/settings/factory-settings";
import type { CursorConnectionStatus } from "@/features/settings/cursor-connection-panel";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import {
  type AgentConfigKey,
  type AgentProvider,
  AGENT_CONFIG_LIMITS,
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
import {
  factorySettingsAgentSchema,
  type FactorySettingsSnapshot,
} from "@/lib/factory-definitions/settings-contracts";
import { discoverCursorModels } from "@/lib/cursor/client";
import { workspaceSettingsPath } from "@/lib/routes";

type AgentConfigSectionProps = {
  anchorId?: string;
  canManage: boolean;
  defaultFactoryName?: string;
  extraContent?: ReactNode;
  initialAgentConfig: AgentConfigMap;
  initialCursorStatus?: CursorConnectionStatus;
  onAgentConfigSaved?: (entries: AgentConfigEntry[]) => void;
  onCursorStatusChange?: (status: CursorConnectionStatus) => void;
  setFlashMessage: (message: FlashMessage) => void;
  title?: string;
  workspaceId: string;
  workspaceSlug: string;
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

function draftAgentConfig(agent: FactorySettingsSnapshot["agent"]): AgentConfigMap {
  return {
    agent_provider: agent.provider,
    agent_model: agent.model,
    agent_effort: agent.effort,
    concurrency_limit: agent.concurrencyLimit,
    stall_timeout_ms: agent.stallTimeoutMs,
    max_retries: agent.maxRetries,
    max_turns: agent.maxTurns,
  };
}

function toDrafts(config: AgentConfigMap): Record<AgentConfigKey, string> {
  return {
    agent_provider: agentConfigValueToDraft("agent_provider", config.agent_provider),
    agent_model: agentConfigValueToDraft("agent_model", config.agent_model),
    agent_effort: agentConfigValueToDraft("agent_effort", config.agent_effort),
    concurrency_limit: agentConfigValueToDraft("concurrency_limit", config.concurrency_limit),
    stall_timeout_ms: agentConfigValueToDraft("stall_timeout_ms", config.stall_timeout_ms),
    max_retries: agentConfigValueToDraft("max_retries", config.max_retries),
    max_turns: agentConfigValueToDraft("max_turns", config.max_turns),
  };
}

export function AgentConfigSection({
  anchorId = "coding-agent",
  canManage,
  defaultFactoryName,
  extraContent,
  initialAgentConfig,
  initialCursorStatus,
  onAgentConfigSaved,
  onCursorStatusChange,
  setFlashMessage,
  title = "Coding agent",
  workspaceId,
  workspaceSlug,
}: AgentConfigSectionProps) {
  const { blocked, revision, stale } = useFactorySettingsForm("agent");
  const baselineAgent = revision?.snapshot.agent;
  const baselineAgentKey = baselineAgent ? JSON.stringify(baselineAgent) : null;
  const [previousBaselineKey, setPreviousBaselineKey] = useState(baselineAgentKey);
  const [agentConfig, setAgentConfig] = useState<AgentConfigMap>(() =>
    baselineAgent ? draftAgentConfig(baselineAgent) : initialAgentConfig,
  );
  const [drafts, setDrafts] = useState(() => toDrafts(agentConfig));
  const [isSaving, setIsSaving] = useState(false);
  const saveInFlightRef = useRef(false);
  const [serverFieldErrors, setServerFieldErrors] = useState<AgentConfigFieldErrors>({});
  const [cursorModels, setCursorModels] = useState<SelectOption[]>([]);
  const [cursorConnected, setCursorConnected] = useState(initialCursorStatus?.connected ?? false);

  if (previousBaselineKey !== baselineAgentKey) {
    const next = baselineAgent ? draftAgentConfig(baselineAgent) : initialAgentConfig;
    setPreviousBaselineKey(baselineAgentKey);
    setAgentConfig(next);
    setDrafts(toDrafts(next));
    setServerFieldErrors({});
  }

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
    const clearDraftEffort = revision && field.configKey === "agent_effort" && draftIsEmpty;
    const validation = clearDraftEffort
      ? { ok: true as const, value: null }
      : draftIsEmpty
        ? null
        : parseAgentConfigDraft(field.configKey, field.type, draft);
    const validationError =
      (isDirty && draftIsEmpty && !clearDraftEffort
        ? `${field.label} is required.`
        : validation && !validation.ok
          ? validation.error
          : null) ??
      serverFieldErrors[field.configKey] ??
      null;
    return { field, draft, isDirty, validation, validationError };
  });
  const hasErrors = fieldStatuses.some((status) => status.validationError !== null);
  const dirtyFields = fieldStatuses.filter((status) => status.isDirty);
  const saveableFields = dirtyFields.filter((status) => status.validation?.ok === true);
  const editorBusy = isSaving || Boolean(revision?.busy);
  const canSave = !editorBusy && saveableFields.length > 0 && !hasErrors;

  function handleFieldChange(key: AgentConfigKey, next: string) {
    const updated = applyAgentConfigDraftChange(drafts, key, next);
    setDrafts(updated);
    if (revision) {
      revision.setDirty(JSON.stringify(updated) !== JSON.stringify(toDrafts(agentConfig)));
    }
    setServerFieldErrors((current) => {
      if (!current[key]) return current;
      const nextErrors = { ...current };
      delete nextErrors[key];
      return nextErrors;
    });
  }

  async function handleSaveAll() {
    if (saveInFlightRef.current || !canSave) return;
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
      if (revision) {
        const merged = { ...agentConfig, ...config };
        const agent = factorySettingsAgentSchema.parse({
          provider: merged.agent_provider,
          model: merged.agent_model,
          effort: agentProviderSupportsEffort(selectedAgentProvider) ? merged.agent_effort : null,
          concurrencyLimit: merged.concurrency_limit,
          stallTimeoutMs: merged.stall_timeout_ms,
          maxRetries: merged.max_retries,
          maxTurns: merged.max_turns,
        });
        const saved = await revision.save({ kind: "agent", agent });
        const accepted = draftAgentConfig(saved.agent);
        setAgentConfig(accepted);
        setDrafts(toDrafts(accepted));
        revision.setDirty(false);
        setFlashMessage({ kind: "success", text: "Coding agent draft saved." });
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

  return (
    <Section
      actions={
        <Link
          className="ui-button min-h-9"
          href={`${workspaceSettingsPath(workspaceSlug, { category: "personal", provider: selectedAgentProvider })}#provider-access`}
          onNavigate={(event) => {
            if (!editorBusy && dirtyFields.length === 0) return;
            event.preventDefault();
            setFlashMessage({
              kind: "info",
              text: "Save or discard your runtime edits before opening provider access.",
            });
          }}
        >
          Provider access
        </Link>
      }
      anchorId={anchorId}
      heading="h3"
      tagline={
        <>
          {revision
            ? canManage
              ? `${defaultFactoryName ?? "Default factory"} draft. Publish it to change how new sessions run.`
              : `Published runtime for ${defaultFactoryName ?? "the default factory"}.`
            : blocked
              ? "Factory runtime settings aren’t available yet."
              : "Live workspace defaults for new sessions."}{" "}
          <a className="font-medium text-accent underline" href="#workspace-secrets">
            Workspace secrets
          </a>{" "}
          are configured separately.
        </>
      }
      title={title}
    >
      <div className={canManage ? "space-y-6" : "space-y-4"}>
        {canManage && !blocked ? (
          <>
            {stale && revision ? (
              <FactorySettingsFormConflict
                discard={() => {
                  setDrafts(toDrafts(agentConfig));
                  setServerFieldErrors({});
                  revision.setDirty(false);
                }}
                section="agent"
              />
            ) : null}
            <div className="space-y-6">
              {fieldStatuses.map((status) => (
                <AgentConfigField
                  key={status.field.configKey}
                  description={status.field.description}
                  disabled={editorBusy}
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
                  idle={revision ? "Save agent draft" : "Save changes"}
                  pending={isSaving}
                  pendingLabel="Saving…"
                />
              </button>
            </div>
          </>
        ) : !canManage ? (
          <p className="type-secondary text-muted">
            Only workspace admins can change the agent runtime.
          </p>
        ) : null}
        {extraContent}
      </div>
    </Section>
  );
}
