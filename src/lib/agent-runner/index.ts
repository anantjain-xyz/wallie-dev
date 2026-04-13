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
 * Currently supports "claude-code". Extend here for future providers.
 */
export function createAgentRunner(provider: string): AgentRunner {
  switch (provider) {
    case "claude-code":
      return new ClaudeCodeRunner();
    default:
      throw new Error(`Unknown agent provider: "${provider}". Supported: claude-code`);
  }
}
