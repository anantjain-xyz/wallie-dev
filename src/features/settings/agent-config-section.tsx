"use client";

import { useMemo, useState } from "react";

import type { UpsertAgentConfigResponse } from "@/app/api/agent-config/route";
import type { VerifyAgentConfigResponse } from "@/app/api/agent-config/verify/route";
import type { AgentConfigMap } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  type AgentConfigKey,
  type AgentProvider,
  AGENT_CONFIG_LIMITS,
  AGENT_PROVIDERS,
  normalizeAgentProviderName,
  parseAgentConfigValue,
} from "@/lib/agent-config/contracts";

type AgentConfigVerifyResult =
  | { kind: "ok" }
  | { kind: "error"; message: string }
  | { kind: "skipped"; reason: string };

type AgentConfigSectionProps = {
  canManage: boolean;
  initialAgentConfig: AgentConfigMap;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

type FieldType = "number" | "select" | "text";

type FieldDescriptor = {
  configKey: AgentConfigKey;
  description: string;
  label: string;
  options?: readonly string[];
  placeholder?: string;
  type: FieldType;
};

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

function mapVerifyResponse(payload: VerifyAgentConfigResponse): AgentConfigVerifyResult {
  switch (payload.ok) {
    case true:
      return { kind: "ok" };
    case "skipped":
      return { kind: "skipped", reason: payload.reason };
    case false:
      return { kind: "error", message: payload.error };
  }
}

function configValueToString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

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
  options?: readonly string[];
  placeholder?: string;
  trailing?: React.ReactNode;
  type: FieldType;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {trailing}
      </div>
      {type === "select" && options ? (
        <select
          className="ui-input"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          value={draft}
        >
          <option value="">Not configured</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          autoComplete="off"
          className="ui-input"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type={type === "number" ? "number" : "text"}
          value={draft}
        />
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
  canManage,
  initialAgentConfig,
  setFlashMessage,
  workspaceId,
}: AgentConfigSectionProps) {
  const [agentConfig, setAgentConfig] = useState<AgentConfigMap>(initialAgentConfig);
  const [drafts, setDrafts] = useState<Record<AgentConfigKey, string>>(() => ({
    agent_provider: configValueToString(initialAgentConfig.agent_provider),
    agent_model: configValueToString(initialAgentConfig.agent_model),
    concurrency_limit: configValueToString(initialAgentConfig.concurrency_limit),
    stall_timeout_ms: configValueToString(initialAgentConfig.stall_timeout_ms),
    max_retries: configValueToString(initialAgentConfig.max_retries),
  }));
  const [verifyState, setVerifyState] = useState<{
    isVerifying: boolean;
    result: AgentConfigVerifyResult | null;
  }>({ isVerifying: false, result: null });

  const saveAgentConfig = useApiAction<UpsertAgentConfigResponse, [AgentConfigKey, unknown]>({
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
    },
    setFlashMessage,
    successText: null,
  });

  const verifyAgentModel = useApiAction<
    VerifyAgentConfigResponse,
    [rawDraft: string, provider: AgentProvider],
    AgentConfigVerifyResult
  >({
    call: (rawDraft, provider) =>
      fetch("/api/agent-config/verify", {
        body: JSON.stringify({
          model: rawDraft.trim(),
          provider,
          workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    errorText: "Verify call failed.",
    onError: (message) => ({ kind: "error", message }),
    onSuccess: mapVerifyResponse,
    setFlashMessage,
    successText: null,
  });

  const selectedAgentProvider: AgentProvider =
    normalizeAgentProviderName(drafts.agent_provider) ?? "codex";

  const fields: FieldDescriptor[] = useMemo(
    () => [
      {
        configKey: "agent_provider",
        description:
          "Which agent CLI or API to use for coding tasks. Anthropic API skips the sandbox (faster for text-only stages).",
        label: "Agent provider",
        options: AGENT_PROVIDERS,
        type: "select",
      },
      {
        configKey: "agent_model",
        description:
          "Model identifier passed to the agent provider. Use Verify to send a 1-token test call with this workspace's stored credentials.",
        label: "Agent model",
        placeholder: "claude-sonnet-4-20250514",
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
        description: `Time in milliseconds before a run with no activity is considered stalled (${AGENT_CONFIG_LIMITS.stall_timeout_ms.min.toLocaleString()}–${AGENT_CONFIG_LIMITS.stall_timeout_ms.max.toLocaleString()} ms).`,
        label: "Stall timeout (ms)",
        placeholder: "300000",
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
    [],
  );

  const fieldStatuses = fields.map((field) => {
    const draft = drafts[field.configKey];
    const currentValue = configValueToString(agentConfig[field.configKey]);
    const isDirty = draft !== currentValue;
    const draftIsEmpty = draft.trim() === "";
    const validation = draftIsEmpty ? null : parseDraftForKey(field.configKey, field.type, draft);
    const validationError = validation && !validation.ok ? validation.error : null;
    return { field, draft, isDirty, validation, validationError };
  });

  const hasErrors = fieldStatuses.some((status) => status.validationError !== null);
  const dirtyFields = fieldStatuses.filter((status) => status.isDirty);
  const canSave = !saveAgentConfig.isBusy && dirtyFields.length > 0 && !hasErrors;
  const canVerify =
    !verifyState.isVerifying && drafts.agent_model.trim() !== "" && !saveAgentConfig.isBusy;

  function handleFieldChange(key: AgentConfigKey, next: string) {
    setDrafts((current) => ({ ...current, [key]: next }));
    if (key === "agent_model") {
      setVerifyState({ isVerifying: false, result: null });
    }
  }

  async function handleSaveAll() {
    const toSave = dirtyFields.filter(
      (status) => status.validation && status.validation.ok === true,
    );
    if (toSave.length === 0) return;

    for (const status of toSave) {
      if (!status.validation || !status.validation.ok) continue;
      await saveAgentConfig.run(status.field.configKey, status.validation.value);
    }

    setFlashMessage({
      kind: "success",
      text: `Saved ${toSave.length} agent setting${toSave.length === 1 ? "" : "s"}.`,
    });
  }

  async function handleVerify() {
    setVerifyState({ isVerifying: true, result: null });
    try {
      const result = await verifyAgentModel.run(drafts.agent_model, selectedAgentProvider);
      setVerifyState({
        isVerifying: false,
        result: result ?? { kind: "error", message: "Verify call failed." },
      });
    } catch (err) {
      setVerifyState({
        isVerifying: false,
        result: { kind: "error", message: err instanceof Error ? err.message : "Verify failed." },
      });
    }
  }

  return (
    <Section
      anchorId="coding-agent"
      tagline="Configure how Wallie runs coding agents in this workspace. These settings apply to all sessions that trigger agent execution."
      title="Coding agent"
    >
      {canManage ? (
        <div className="space-y-6">
          <div className="space-y-6">
            {fieldStatuses.map((status) => (
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
                trailing={
                  status.field.configKey === "agent_model" ? (
                    <div className="flex items-center gap-2">
                      {verifyState.result ? (
                        <span
                          className={`text-[12px] ${
                            verifyState.result.kind === "ok"
                              ? "text-success"
                              : verifyState.result.kind === "skipped"
                                ? "text-muted"
                                : "text-danger"
                          }`}
                          role="status"
                        >
                          {verifyState.result.kind === "ok"
                            ? "✓ Reachable"
                            : verifyState.result.kind === "skipped"
                              ? `ⓘ ${verifyState.result.reason}`
                              : `✗ ${verifyState.result.message}`}
                        </span>
                      ) : null}
                      <button
                        className="ui-button"
                        disabled={!canVerify}
                        onClick={() => void handleVerify()}
                        type="button"
                      >
                        {verifyState.isVerifying ? "Verifying…" : "Verify"}
                      </button>
                    </div>
                  ) : undefined
                }
              />
            ))}
          </div>

          {selectedAgentProvider === "codex" ? (
            <p className="text-[12px] leading-5 text-muted">
              Each session runs with its creator&apos;s Codex account. Connect yours below under
              &ldquo;Codex account&rdquo;.
            </p>
          ) : null}
          {selectedAgentProvider === "anthropic-api" ? (
            <p className="text-[12px] leading-5 text-muted">
              Calls Anthropic&apos;s Messages API directly — no sandbox spawn, no GitHub repo
              required. Add your <code>ANTHROPIC_API_KEY</code> under Secrets above.
            </p>
          ) : null}

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
        </div>
      ) : (
        <p className="text-[13px] leading-6 text-muted">
          Workspace admins can configure coding agent settings from this page.
        </p>
      )}
    </Section>
  );
}
