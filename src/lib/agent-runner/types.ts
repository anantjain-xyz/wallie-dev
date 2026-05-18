/**
 * Agent Runner abstraction — defines the contract for launching coding agents
 * inside a per-session sandbox. Implementations stream structured events back
 * to the caller for persistence and real-time UI.
 */

import {
  RECOMMENDED_CLAUDE_CODE_EFFORT,
  RECOMMENDED_CODEX_REASONING_EFFORT,
  getRecommendedAgentModel,
} from "@/lib/agent-config/contracts";
import type { AgentProvider, SandboxHandle } from "@/lib/sandbox/types";

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
  /**
   * Sandbox the agent CLI runs inside. Owned by the phase; reused across turns.
   * Optional at the interface boundary; current CLI runners (codex,
   * claude-code) require it and assert at start.
   */
  sandbox?: SandboxHandle;
  prompt: string;
  /** Optional session ID from a previous turn for continuation. */
  continueSessionId?: string;
  /** Max output tokens for the agent (optional, provider-specific). */
  maxTokens?: number;
}

export interface AgentRunner {
  readonly provider: AgentProvider;

  /**
   * Whether this runner needs a per-session sandbox. CLI runners do; runners
   * that hit a hosted API directly do not. The pipeline reads this to skip
   * sandbox/GitHub provisioning for text-only stages.
   */
  readonly requiresSandbox: boolean;

  /**
   * Launch the agent with the provided prompt.
   * Returns an async iterable of structured events.
   */
  start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent>;
}

// ---------------------------------------------------------------------------
// Agent Runner Configuration
// ---------------------------------------------------------------------------

export interface AgentRunnerConfig {
  /** Which provider to use: "codex" | "claude-code". */
  provider: AgentProvider;
  /** Model to use (provider-specific, e.g. "gpt-5.5" or "claude-opus-4-7[1m]"). */
  model?: string;
  /** Maximum turns per agent invocation. */
  maxTurns?: number;
}

export const DEFAULT_CODEX_MODEL = getRecommendedAgentModel("codex");
export const DEFAULT_CLAUDE_CODE_MODEL = getRecommendedAgentModel("claude-code");
export const DEFAULT_CODEX_REASONING_EFFORT = RECOMMENDED_CODEX_REASONING_EFFORT;
export const DEFAULT_CLAUDE_CODE_EFFORT = RECOMMENDED_CLAUDE_CODE_EFFORT;

export const DEFAULT_AGENT_RUNNER_CONFIG: AgentRunnerConfig = {
  provider: "codex",
  model: DEFAULT_CODEX_MODEL,
  maxTurns: 5,
};
