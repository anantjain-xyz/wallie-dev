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

export {
  DEFAULT_AGENT_RUNNER_CONFIG,
  DEFAULT_CLAUDE_CODE_EFFORT,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_OPENCODE_MODEL,
} from "./types";
export { ClaudeCodeRunner } from "./claude-code";
export { CodexRunner } from "./codex";
export { OpenCodeRunner } from "./opencode";
export { loadWorkspaceAgentConfig, type ResolvedWorkspaceAgentConfig } from "./workspace-config";

import type { AgentRunner } from "./types";
import {
  AGENT_PROVIDERS,
  normalizeAgentProviderName,
  type AgentProvider,
} from "@/lib/agent-config/contracts";
import { ClaudeCodeRunner, type ClaudeCodeRunnerOptions } from "./claude-code";
import { CodexRunner, type CodexRunnerOptions } from "./codex";
import { OpenCodeRunner, type OpenCodeRunnerOptions } from "./opencode";

export interface CreateAgentRunnerOptions {
  /** Required when provider resolves to "claude-code". */
  claudeCode?: ClaudeCodeRunnerOptions;
  /** Required when provider resolves to "codex". */
  codex?: CodexRunnerOptions;
  /** Required when provider resolves to "opencode". */
  openCode?: OpenCodeRunnerOptions;
}

type AgentProviderName = AgentProvider | "claude_code";

/**
 * Factory: create an AgentRunner for the given provider name.
 * Accepts the legacy underscore aliases at this boundary, then runs internally
 * on the canonical dashed provider ids.
 *
 * CLI providers require caller-supplied credentials; resolve them with the
 * provider token helper before calling.
 */
export function createAgentRunner(
  provider: AgentProviderName,
  opts: CreateAgentRunnerOptions = {},
): AgentRunner {
  const normalized = normalizeAgentProviderName(provider);
  switch (normalized) {
    case "claude-code":
      if (!opts.claudeCode) {
        throw new Error(
          "claude-code provider requires an Anthropic API key (pass opts.claudeCode to createAgentRunner).",
        );
      }
      return new ClaudeCodeRunner(opts.claudeCode);
    case "codex":
      if (!opts.codex) {
        throw new Error(
          "codex provider requires codex credentials (pass opts.codex to createAgentRunner).",
        );
      }
      return new CodexRunner(opts.codex);
    case "opencode":
      if (!opts.openCode) {
        throw new Error(
          "opencode provider requires an OpenCode Zen API key (pass opts.openCode to createAgentRunner).",
        );
      }
      return new OpenCodeRunner(opts.openCode);
    default:
      throw new Error(
        `Unknown agent provider: "${provider}". Supported: ${AGENT_PROVIDERS.join(", ")}`,
      );
  }
}
