import { describe, expect, it } from "vitest";

import { createAgentRunner, ClaudeCodeRunner, DEFAULT_AGENT_RUNNER_CONFIG } from "./index";

describe("createAgentRunner", () => {
  it("creates a ClaudeCodeRunner for 'claude-code'", () => {
    const runner = createAgentRunner("claude-code");
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(runner.provider).toBe("claude-code");
  });

  it("creates a ClaudeCodeRunner for 'claude_code' (settings alias)", () => {
    const runner = createAgentRunner("claude_code");
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(runner.provider).toBe("claude-code");
  });

  it("throws for unknown provider", () => {
    expect(() => createAgentRunner("unknown-provider")).toThrow(
      'Unknown agent provider: "unknown-provider"',
    );
  });
});

describe("DEFAULT_AGENT_RUNNER_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_AGENT_RUNNER_CONFIG.provider).toBe("claude-code");
    expect(DEFAULT_AGENT_RUNNER_CONFIG.maxTurns).toBe(5);
  });
});
