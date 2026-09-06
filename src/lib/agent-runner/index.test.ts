import { describe, expect, it } from "vitest";

import {
  ClaudeCodeRunner,
  CodexRunner,
  CursorRunner,
  OpenCodeRunner,
  createAgentRunner,
  DEFAULT_AGENT_RUNNER_CONFIG,
  DEFAULT_AGENT_EFFORT,
  DEFAULT_CLAUDE_CODE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENCODE_MODEL,
} from "./index";

describe("createAgentRunner", () => {
  it("creates a ClaudeCodeRunner for 'claude-code'", () => {
    const runner = createAgentRunner("claude-code", {
      claudeCode: { credential: { secret: "sk-ant-test" }, model: "claude-sonnet-4-5" },
    });
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
    expect(runner.provider).toBe("claude-code");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("creates a ClaudeCodeRunner for 'claude_code' (settings alias)", () => {
    const runner = createAgentRunner("claude_code", {
      claudeCode: { credential: { secret: "sk-ant-test" } },
    });
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

  it("throws when claude-code is selected without credentials", () => {
    expect(() => createAgentRunner("claude-code")).toThrow(/Anthropic API key/);
  });

  it("creates a CursorRunner when Cursor credentials are provided", () => {
    const runner = createAgentRunner("cursor", {
      cursor: {
        credential: {
          expiresAt: "2026-11-27T00:00:00.000Z",
          generation: "11111111-1111-4111-8111-111111111111",
          secret: "cursor-key",
          userId: "user-1",
        },
      },
    });
    expect(runner).toBeInstanceOf(CursorRunner);
    expect(runner.provider).toBe("cursor");
  });

  it("creates an OpenCodeRunner when a Zen API key is provided", () => {
    const runner = createAgentRunner("opencode", {
      openCode: { credential: { secret: "zen-test-key" } },
    });
    expect(runner).toBeInstanceOf(OpenCodeRunner);
    expect(runner.provider).toBe("opencode");
  });

  it("creates an OpenCodeRunner for a custom provider key", () => {
    const runner = createAgentRunner("opencode", {
      openCode: {
        model: "opencode-go/glm-5.3",
        providerCredentials: { "opencode-go": { secret: "go-key" } },
      },
    });
    expect(runner).toBeInstanceOf(OpenCodeRunner);
  });

  it("throws when OpenCode is selected without credentials", () => {
    expect(() => createAgentRunner("opencode")).toThrow(/OpenCode credentials/);
  });

  it("throws for unknown provider", () => {
    expect(() => createAgentRunner("unknown-provider" as never)).toThrow(
      'Unknown agent provider: "unknown-provider". Supported: codex, claude-code, cursor, opencode',
    );
  });
});

describe("DEFAULT_AGENT_RUNNER_CONFIG", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_AGENT_RUNNER_CONFIG.provider).toBe("codex");
    expect(DEFAULT_AGENT_RUNNER_CONFIG.model).toBe(DEFAULT_CODEX_MODEL);
    expect(DEFAULT_AGENT_RUNNER_CONFIG.effort).toBe(DEFAULT_AGENT_EFFORT);
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
    expect(DEFAULT_CLAUDE_CODE_MODEL).toBe("claude-opus-4-8[1m]");
    expect(DEFAULT_OPENCODE_MODEL).toBe("opencode/gpt-5.6-sol");
    expect(DEFAULT_AGENT_RUNNER_CONFIG.maxTurns).toBe(5);
  });
});
