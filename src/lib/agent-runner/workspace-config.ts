import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  AGENT_PROVIDERS,
  normalizeAgentProviderName,
  type AgentProvider,
} from "@/lib/agent-config/contracts";
import type { Database } from "@/lib/supabase/database.types";

import { DEFAULT_AGENT_RUNNER_CONFIG } from "./types";

type AdminClient = SupabaseClient<Database>;

export interface ResolvedWorkspaceAgentConfig {
  /** Workspace-configured model, or the runner default. Always set. */
  model: string;
  /** Canonical provider id ("codex" | "claude-code" | "anthropic-api"), normalized from the underscore form persisted by the settings UI. Always set. */
  provider: AgentProvider;
  /** Workspace-configured max turns, or undefined if unset. */
  maxTurns?: number;
}

/**
 * Load the agent runner config a workspace has chosen. Falls back to runner
 * defaults for any key that is unset.
 *
 * Both the queue layer (service.ts) and the executor (pipeline/processor.ts)
 * call this so the `agent_runs` rows they insert agree on which model is
 * actually being used. Drift between the two would re-introduce the original
 * `agent_runs.model_name = "wallie-control-plane-stub"` bug.
 */
export async function loadWorkspaceAgentConfig(
  admin: AdminClient,
  workspaceId: string,
): Promise<ResolvedWorkspaceAgentConfig> {
  const { data } = await admin
    .from("workspace_agent_config")
    .select("key, value_json")
    .eq("workspace_id", workspaceId)
    .in("key", ["max_turns", "agent_provider", "agent_model"]);

  const lookup: Record<string, unknown> = {};
  for (const row of data ?? []) {
    lookup[row.key] = row.value_json;
  }

  const rawProvider = typeof lookup.agent_provider === "string" ? lookup.agent_provider : undefined;
  const rawModel = typeof lookup.agent_model === "string" ? lookup.agent_model : undefined;
  const defaultModel = DEFAULT_AGENT_RUNNER_CONFIG.model;
  const provider = rawProvider
    ? normalizeAgentProviderName(rawProvider)
    : DEFAULT_AGENT_RUNNER_CONFIG.provider;
  if (!defaultModel) {
    throw new Error("DEFAULT_AGENT_RUNNER_CONFIG.model must be set.");
  }
  if (!provider) {
    throw new Error(
      `Unknown agent provider: "${rawProvider}". Supported: ${AGENT_PROVIDERS.join(", ")}`,
    );
  }

  return {
    maxTurns: typeof lookup.max_turns === "number" ? lookup.max_turns : undefined,
    model: rawModel ?? defaultModel,
    provider,
  };
}
