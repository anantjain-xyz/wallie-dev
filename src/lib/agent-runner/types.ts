/**
 * Agent Runner abstraction — defines the contract for launching coding agents
 * within a provisioned workspace. Implementations stream structured events
 * back to the caller for persistence and real-time UI.
 */

// ---------------------------------------------------------------------------
// Agent Events
// ---------------------------------------------------------------------------

export interface AgentEventText {
  type: "text";
  text: string;
}

export interface AgentEventToolUse {
  type: "tool_use";
  tool: string;
  input: string;
}

export interface AgentEventCompletion {
  type: "completion";
  /** Whether the agent signalled it finished its task (vs. hitting turn limit). */
  taskComplete: boolean;
  summary: string;
  /** Token usage reported by the agent, if available. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AgentEventError {
  type: "error";
  message: string;
}

export type AgentEvent =
  | AgentEventText
  | AgentEventToolUse
  | AgentEventCompletion
  | AgentEventError;

// ---------------------------------------------------------------------------
// Agent Runner Interface
// ---------------------------------------------------------------------------

export interface AgentRunnerStartInput {
  sessionId: string;
  workspacePath: string;
  prompt: string;
  /** Optional session ID from a previous turn for continuation. */
  continueSessionId?: string;
  /** Max output tokens for the agent (optional, provider-specific). */
  maxTokens?: number;
}

export interface AgentRunner {
  readonly provider: string;

  /**
   * Launch the agent in the given workspace directory with the provided prompt.
   * Returns an async iterable of structured events.
   */
  start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent>;
}

// ---------------------------------------------------------------------------
// Agent Runner Configuration
// ---------------------------------------------------------------------------

export interface AgentRunnerConfig {
  /** Which provider to use: "codex" | "claude-code" */
  provider: string;
  /** Model to use (provider-specific, e.g. "gpt-5-codex" or "claude-sonnet-4-20250514"). */
  model?: string;
  /** Maximum turns per agent invocation. */
  maxTurns?: number;
}

export const DEFAULT_CODEX_MODEL = "gpt-5-codex";

export const DEFAULT_AGENT_RUNNER_CONFIG: AgentRunnerConfig = {
  provider: "codex",
  model: DEFAULT_CODEX_MODEL,
  maxTurns: 5,
};
