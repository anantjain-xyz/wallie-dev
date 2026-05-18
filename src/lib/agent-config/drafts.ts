import {
  type AgentConfigKey,
  normalizeAgentProviderName,
  getRecommendedAgentModel,
} from "@/lib/agent-config/contracts";

export type AgentConfigDrafts = Record<AgentConfigKey, string>;

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
