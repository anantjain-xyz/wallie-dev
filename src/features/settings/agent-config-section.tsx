"use client";

import { useState } from "react";

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

function parseDraftForKey(
  configKey: AgentConfigKey,
  type: "number" | "select" | "text",
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

function AgentConfigField({
  configKey,
  description,
  disabled,
  label,
  onSave,
  onVerify,
  options,
  placeholder,
  type,
  value,
}: {
  configKey: AgentConfigKey;
  description: string;
  disabled: boolean;
  label: string;
  onSave: (key: AgentConfigKey, value: unknown) => Promise<void>;
  onVerify?: (rawDraft: string) => Promise<AgentConfigVerifyResult>;
  options?: readonly string[];
  placeholder?: string;
  type: "number" | "select" | "text";
  value: unknown;
}) {
  const currentValue = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const [draft, setDraft] = useState(currentValue);
  const [verifyState, setVerifyState] = useState<{
    isVerifying: boolean;
    result: AgentConfigVerifyResult | null;
  }>({ isVerifying: false, result: null });
  const isDirty = draft !== currentValue;

  const draftIsEmpty = draft.trim() === "";
  const validation = draftIsEmpty ? null : parseDraftForKey(configKey, type, draft);
  const validationError = validation && !validation.ok ? validation.error : null;
  const canSave = !disabled && isDirty && validation?.ok === true;
  const canVerify =
    Boolean(onVerify) && !disabled && !verifyState.isVerifying && draft.trim() !== "";

  function handleDraftChange(next: string) {
    setDraft(next);
    setVerifyState({ isVerifying: false, result: null });
  }

  function handleSave() {
    if (!validation?.ok) return;
    void onSave(configKey, validation.value);
  }

  async function handleVerify() {
    if (!onVerify) return;
    setVerifyState({ isVerifying: true, result: null });
    try {
      const result = await onVerify(draft);
      setVerifyState({ isVerifying: false, result });
    } catch (error) {
      setVerifyState({
        isVerifying: false,
        result: {
          kind: "error",
          message: error instanceof Error ? error.message : "Verify call failed.",
        },
      });
    }
  }

  return (
    <div className="ui-subpanel space-y-4 p-4">
      <label className="space-y-2 text-sm font-semibold text-foreground">
        <span>{label}</span>
        {type === "select" && options ? (
          <select
            className="ui-input"
            disabled={disabled}
            onChange={(event) => handleDraftChange(event.target.value)}
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
            onChange={(event) => handleDraftChange(event.target.value)}
            placeholder={placeholder}
            type={type === "number" ? "number" : "text"}
            value={draft}
          />
        )}
      </label>
      {validationError ? (
        <p className="text-xs leading-5 text-danger" role="alert">
          {validationError}
        </p>
      ) : null}
      <p className="text-xs leading-5 text-muted">{description}</p>
      {verifyState.result ? (
        <p
          className={`text-xs leading-5 ${
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
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {onVerify ? (
          <button
            className="ui-button"
            disabled={!canVerify}
            onClick={() => void handleVerify()}
            type="button"
          >
            {verifyState.isVerifying ? "Verifying…" : "Verify"}
          </button>
        ) : null}
        <button
          className="ui-button-primary"
          disabled={!canSave}
          onClick={handleSave}
          type="button"
        >
          Save
        </button>
      </div>
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
    successText: (_payload, [key]) => `Saved ${key}.`,
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

  async function handleSaveAgentConfig(key: AgentConfigKey, value: unknown) {
    await saveAgentConfig.run(key, value);
  }

  async function handleVerifyAgentModel(rawDraft: string): Promise<AgentConfigVerifyResult> {
    return (
      (await verifyAgentModel.run(rawDraft, selectedAgentProvider)) ?? {
        kind: "error",
        message: "Verify call failed.",
      }
    );
  }

  const selectedAgentProvider: AgentProvider =
    typeof agentConfig.agent_provider === "string"
      ? (normalizeAgentProviderName(agentConfig.agent_provider) ?? "codex")
      : "codex";

  return (
    <Section title="Coding Agent">
      <div className="space-y-4">
        <p className="text-sm leading-7 text-muted">
          Configure how Wallie runs coding agents in this workspace. These settings apply to all
          sessions that trigger agent execution.
        </p>

        {canManage ? (
          <div className="space-y-4">
            <AgentConfigField
              configKey="agent_provider"
              description="Which agent CLI or API to use for coding tasks. Anthropic API skips the sandbox (faster for text-only stages)."
              disabled={saveAgentConfig.isBusy}
              label="Agent Provider"
              onSave={handleSaveAgentConfig}
              options={AGENT_PROVIDERS}
              type="select"
              value={selectedAgentProvider}
            />
            {selectedAgentProvider === "codex" ? (
              <p className="text-xs leading-5 text-muted">
                Each session runs with its creator&apos;s Codex account. Connect yours below under
                &ldquo;Your Codex account&rdquo;.
              </p>
            ) : null}
            {selectedAgentProvider === "anthropic-api" ? (
              <p className="text-xs leading-5 text-muted">
                Calls Anthropic&apos;s Messages API directly — no sandbox spawn, no GitHub repo
                required. Add your <code>ANTHROPIC_API_KEY</code> under Integrations above.
              </p>
            ) : null}
            <AgentConfigField
              configKey="agent_model"
              description="Model identifier passed to the agent provider. Use Verify to send a 1-token test call with this workspace's stored credentials."
              disabled={saveAgentConfig.isBusy || verifyAgentModel.isBusy}
              label="Agent Model"
              onSave={handleSaveAgentConfig}
              onVerify={handleVerifyAgentModel}
              placeholder="claude-sonnet-4-20250514"
              type="text"
              value={agentConfig.agent_model}
            />
            <AgentConfigField
              configKey="concurrency_limit"
              description={`Max number of agent jobs that can run simultaneously (${AGENT_CONFIG_LIMITS.concurrency_limit.min}–${AGENT_CONFIG_LIMITS.concurrency_limit.max}).`}
              disabled={saveAgentConfig.isBusy}
              label="Concurrency Limit"
              onSave={handleSaveAgentConfig}
              placeholder="1"
              type="number"
              value={agentConfig.concurrency_limit}
            />
            <AgentConfigField
              configKey="stall_timeout_ms"
              description={`Time in milliseconds before a run with no activity is considered stalled (${AGENT_CONFIG_LIMITS.stall_timeout_ms.min.toLocaleString()}–${AGENT_CONFIG_LIMITS.stall_timeout_ms.max.toLocaleString()} ms).`}
              disabled={saveAgentConfig.isBusy}
              label="Stall Timeout (ms)"
              onSave={handleSaveAgentConfig}
              placeholder="300000"
              type="number"
              value={agentConfig.stall_timeout_ms}
            />
            <AgentConfigField
              configKey="max_retries"
              description={`Maximum automatic retries for failed agent runs (${AGENT_CONFIG_LIMITS.max_retries.min}–${AGENT_CONFIG_LIMITS.max_retries.max}).`}
              disabled={saveAgentConfig.isBusy}
              label="Max Retries"
              onSave={handleSaveAgentConfig}
              placeholder="3"
              type="number"
              value={agentConfig.max_retries}
            />
          </div>
        ) : (
          <div className="ui-subpanel p-4 text-sm leading-7 text-muted">
            Workspace admins can configure coding agent settings from this page.
          </div>
        )}
      </div>
    </Section>
  );
}
