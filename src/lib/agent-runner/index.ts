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

import type { AgentRunner } from "./types";
import { ClaudeCodeRunner } from "./claude-code";
import { CodexRunner, type CodexRunnerOptions } from "./codex";

export interface CreateAgentRunnerOptions {
  /** Required when provider resolves to "codex". */
  codex?: CodexRunnerOptions;
}

/**
 * Factory: create an AgentRunner for the given provider name.
 * Normalizes common aliases (e.g. "claude_code" -> "claude-code") so the
 * value persisted by the workspace settings UI works without transformation.
 *
 * Codex requires caller-supplied OAuth credentials; resolve them with
 * getCodexAccessTokenForUser from "@/lib/codex/tokens" before calling.
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
    default:
      throw new Error(
        `Unknown agent provider: "${provider}". Supported: codex, claude-code, claude_code`,
      );
  }
}
