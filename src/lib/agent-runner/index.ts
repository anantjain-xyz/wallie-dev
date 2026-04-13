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

export { DEFAULT_AGENT_RUNNER_CONFIG } from "./types";
export { ClaudeCodeRunner } from "./claude-code";

import type { AgentRunner } from "./types";
import { ClaudeCodeRunner } from "./claude-code";

/**
 * Factory: create an AgentRunner for the given provider name.
 * Normalizes common aliases (e.g. "claude_code" -> "claude-code") so the
 * value persisted by the workspace settings UI works without transformation.
 */
export function createAgentRunner(provider: string): AgentRunner {
  const normalized = provider.replace(/_/g, "-");
  switch (normalized) {
    case "claude-code":
      return new ClaudeCodeRunner();
    default:
      throw new Error(`Unknown agent provider: "${provider}". Supported: claude-code, claude_code`);
  }
}
