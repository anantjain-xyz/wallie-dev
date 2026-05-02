export type {
  AgentEvent,
  AgentEventCompletion,
  AgentEventError,
  AgentEventText,
  AgentEventToolUse,
  AgentRunner,
  AgentRunnerConfig,
  AgentRunnerStartInput,
} from "./types";

export { DEFAULT_AGENT_RUNNER_CONFIG, DEFAULT_CODEX_MODEL } from "./types";
export { ClaudeCodeRunner } from "./claude-code";
export { CodexRunner } from "./codex";
export { AnthropicApiRunner, DEFAULT_ANTHROPIC_MODEL } from "./anthropic-api";
export {
  loadWorkspaceAgentConfig,
  normalizeAgentProviderName,
  type ResolvedWorkspaceAgentConfig,
} from "./workspace-config";

import type { AgentRunner } from "./types";
import { AnthropicApiRunner, type AnthropicApiRunnerOptions } from "./anthropic-api";
import { ClaudeCodeRunner } from "./claude-code";
import { CodexRunner, type CodexRunnerOptions } from "./codex";

export interface CreateAgentRunnerOptions {
  /** Required when provider resolves to "codex". */
  codex?: CodexRunnerOptions;
  /** Required when provider resolves to "anthropic-api". */
  anthropic?: AnthropicApiRunnerOptions;
}

/**
 * Factory: create an AgentRunner for the given provider name.
 * Normalizes common aliases (e.g. "claude_code" -> "claude-code", "anthropic_api"
 * -> "anthropic-api") so the value persisted by the workspace settings UI works
 * without transformation.
 *
 * Codex requires caller-supplied OAuth credentials; resolve them with
 * getCodexAccessTokenForUser from "@/lib/codex/tokens" before calling.
 * Anthropic API requires an API key; load it from `workspace_secrets`.
 */
export function createAgentRunner(
  provider: string,
  opts: CreateAgentRunnerOptions = {},
): AgentRunner {
  const normalized = provider.replace(/_/g, "-");
  switch (normalized) {
    case "claude-code":
      return new ClaudeCodeRunner();
    case "codex":
      if (!opts.codex) {
        throw new Error(
          "codex provider requires codex auth (pass opts.codex to createAgentRunner).",
        );
      }
      return new CodexRunner(opts.codex);
    case "anthropic-api":
      if (!opts.anthropic) {
        throw new Error(
          "anthropic-api provider requires anthropic auth (pass opts.anthropic to createAgentRunner).",
        );
      }
      return new AnthropicApiRunner(opts.anthropic);
    default:
      throw new Error(
        `Unknown agent provider: "${provider}". Supported: codex, claude-code, claude_code, anthropic-api, anthropic_api`,
      );
  }
}
