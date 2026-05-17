import { describe, expect, it } from "vitest";

import {
  AnthropicApiRunner,
  ClaudeCodeRunner,
  CodexRunner,
  createAgentRunner,
  DEFAULT_AGENT_RUNNER_CONFIG,
  DEFAULT_ANTHROPIC_MODEL,
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

  it("creates an AnthropicApiRunner for 'anthropic-api' when auth is provided", () => {
    const runner = createAgentRunner("anthropic-api", { anthropic: { apiKey: "sk" } });
    expect(runner).toBeInstanceOf(AnthropicApiRunner);
    expect(runner.provider).toBe("anthropic-api");
    expect(runner.requiresSandbox).toBe(false);
  });

  it("creates an AnthropicApiRunner for 'anthropic_api' (settings alias)", () => {
    const runner = createAgentRunner("anthropic_api", { anthropic: { apiKey: "sk" } });
    expect(runner).toBeInstanceOf(AnthropicApiRunner);
    expect(runner.provider).toBe("anthropic-api");
  });

  it("throws when codex is selected without auth", () => {
    expect(() => createAgentRunner("codex")).toThrow(/codex auth/);
  });

  it("throws when anthropic-api is selected without auth", () => {
    expect(() => createAgentRunner("anthropic-api")).toThrow(/anthropic auth/);
  });

  it("throws for unknown provider", () => {
    expect(() => createAgentRunner("unknown-provider" as never)).toThrow(
      'Unknown agent provider: "unknown-provider". Supported: codex, claude-code, anthropic-api',
    );
  });
});

describe("DEFAULT_AGENT_RUNNER_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_AGENT_RUNNER_CONFIG.provider).toBe("codex");
    expect(DEFAULT_AGENT_RUNNER_CONFIG.model).toBe(DEFAULT_CODEX_MODEL);
    expect(DEFAULT_AGENT_RUNNER_CONFIG.maxTurns).toBe(5);
  });

  it("exports the Anthropic runner default from the shared defaults module", () => {
    expect(DEFAULT_ANTHROPIC_MODEL).toBe("claude-opus-4-7");
  });
});
