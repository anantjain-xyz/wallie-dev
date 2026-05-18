import { describe, expect, it } from "vitest";

import {
  ClaudeCodeRunner,
  CodexRunner,
  createAgentRunner,
  DEFAULT_AGENT_RUNNER_CONFIG,
  DEFAULT_CODEX_MODEL,
} from "./index";

describe("createAgentRunner", () => {
  it("creates a ClaudeCodeRunner for 'claude-code'", () => {
    const runner = createAgentRunner("claude-code");
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(runner.provider).toBe("claude-code");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("creates a ClaudeCodeRunner for 'claude_code' (settings alias)", () => {
    const runner = createAgentRunner("claude_code");
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(runner.provider).toBe("claude-code");
  });

  it("creates a CodexRunner for 'codex' when auth is provided", () => {
    const runner = createAgentRunner("codex", { codex: { accessToken: "tok" } });
    expect(runner).toBeInstanceOf(CodexRunner);
    expect(runner.provider).toBe("codex");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("throws when codex is selected without auth", () => {
    expect(() => createAgentRunner("codex")).toThrow(/codex auth/);
  });

  it("throws for unknown provider", () => {
    expect(() => createAgentRunner("unknown-provider" as never)).toThrow(
      'Unknown agent provider: "unknown-provider". Supported: codex, claude-code',
    );
  });
});

describe("DEFAULT_AGENT_RUNNER_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_AGENT_RUNNER_CONFIG.provider).toBe("codex");
    expect(DEFAULT_AGENT_RUNNER_CONFIG.model).toBe(DEFAULT_CODEX_MODEL);
    expect(DEFAULT_AGENT_RUNNER_CONFIG.maxTurns).toBe(5);
  });
});
