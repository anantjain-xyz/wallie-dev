import {
  type AgentConfigKey,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  formatStallTimeoutMinutes,
  getRecommendedAgentModel,
  normalizeAgentProviderName,
  parseAgentConfigValue,
  parseStallTimeoutMinutes,
} from "@/lib/agent-config/contracts";

export type AgentConfigDrafts = Record<AgentConfigKey, string>;

export type AgentConfigFieldType = "number" | "select" | "text";

export function applyAgentConfigDraftChange(
  current: AgentConfigDrafts,
  key: AgentConfigKey,
  next: string,
): AgentConfigDrafts {
  const nextDrafts = { ...current, [key]: next };
  if (key !== "agent_provider") return nextDrafts;

  const provider = normalizeAgentProviderName(next);
  return provider ? { ...nextDrafts, agent_model: getRecommendedAgentModel(provider) } : nextDrafts;
}

function configValueToString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function isMissingOrEmptyAgentProvider(value: unknown): boolean {
  // Match loadWorkspaceAgentConfig: only non-strings and "" are unset. A
  // whitespace-only string is truthy there and must not look like Codex here.
  return typeof value !== "string" || value === "";
}

/**
 * Persist the displayed Codex fallback for a missing/legacy-empty provider on
 * the next explicit save. Rendering already shows Codex without marking dirty.
 */
export function pendingAgentProviderPersistValue(
  storedProvider: unknown,
  draftProvider: string,
): unknown | undefined {
  if (!isMissingOrEmptyAgentProvider(storedProvider)) return undefined;
  const parsed = parseAgentConfigDraft("agent_provider", "select", draftProvider);
  return parsed.ok ? parsed.value : undefined;
}

/**
 * Convert a stored agent-config value into its editable draft string. Most keys
 * map 1:1, but stall_timeout_ms is stored in milliseconds and edited in minutes,
 * so this is the single conversion point on the read path.
 *
 * Missing or legacy-empty agent_provider values resolve to the runtime Codex
 * fallback for display only — this does not write storage.
 */
export function agentConfigValueToDraft(key: AgentConfigKey, value: unknown): string {
  if (key === "stall_timeout_ms" && typeof value === "number") {
    return formatStallTimeoutMinutes(value);
  }
  if (key === "agent_provider") {
    if (isMissingOrEmptyAgentProvider(value)) {
      return RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider;
    }
    const stored = value as string;
    return normalizeAgentProviderName(stored) ?? stored;
  }
  return configValueToString(value);
}

/**
 * Validate a draft string for a config key and return the value in the stored
 * contract. stall_timeout_ms drafts are entered in minutes but resolve to
 * milliseconds; every other key parses to its raw stored value.
 */
export function parseAgentConfigDraft(
  key: AgentConfigKey,
  type: AgentConfigFieldType,
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
    if (key === "stall_timeout_ms") {
      return parseStallTimeoutMinutes(numeric);
    }
    return parseAgentConfigValue(key, numeric);
  }

  if (type === "select") {
    if (trimmed === "") {
      return { ok: false, error: "Pick a value." };
    }
    return parseAgentConfigValue(key, trimmed);
  }

  return parseAgentConfigValue(key, trimmed);
}
