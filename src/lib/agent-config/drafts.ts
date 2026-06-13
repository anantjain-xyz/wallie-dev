import {
  type AgentConfigKey,
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

/**
 * Convert a stored agent-config value into its editable draft string. Most keys
 * map 1:1, but stall_timeout_ms is stored in milliseconds and edited in minutes,
 * so this is the single conversion point on the read path.
 */
export function agentConfigValueToDraft(key: AgentConfigKey, value: unknown): string {
  if (key === "stall_timeout_ms" && typeof value === "number") {
    return formatStallTimeoutMinutes(value);
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
