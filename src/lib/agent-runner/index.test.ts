import { describe, expect, it } from "vitest";

import {
  ClaudeCodeRunner,
  CodexRunner,
  createAgentRunner,
  DEFAULT_AGENT_RUNNER_CONFIG,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
} from "./index";

describe("createAgentRunner", () => {
  it("creates a ClaudeCodeRunner for 'claude-code'", () => {
    const runner = createAgentRunner("claude-code", {
      claudeCode: { model: "claude-sonnet-4-5" },
    });
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(runner.provider).toBe("claude-code");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("creates a ClaudeCodeRunner for 'claude_code' (settings alias)", () => {
    const runner = createAgentRunner("claude_code");
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(runner.provider).toBe("claude-code");
  });

  it("creates a CodexRunner for 'codex' when credentials are provided", () => {
    const runner = createAgentRunner("codex", {
      codex: { credential: { expiresAt: null, secret: "tok", type: "codex_access_token" } },
    });
    expect(runner).toBeInstanceOf(CodexRunner);
    expect(runner.provider).toBe("codex");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("throws when codex is selected without credentials", () => {
    expect(() => createAgentRunner("codex")).toThrow(/codex credentials/);
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
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.5");
    expect(DEFAULT_CLAUDE_CODE_MODEL).toBe("claude-opus-4-7[1m]");
    expect(DEFAULT_AGENT_RUNNER_CONFIG.maxTurns).toBe(5);
  });
});
