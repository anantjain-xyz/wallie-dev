import { describe, expect, it } from "vitest";

import {
  AGENT_CONFIG_LIMITS,
  AGENT_PROVIDERS,
  isAgentConfigKey,
  isAgentProvider,
  modelMatchesProvider,
  parseAgentConfigValue,
} from "./contracts";

describe("parseAgentConfigValue — concurrency_limit", () => {
  it("accepts integers within range", () => {
    expect(parseAgentConfigValue("concurrency_limit", 1)).toEqual({ ok: true, value: 1 });
    expect(parseAgentConfigValue("concurrency_limit", 20)).toEqual({ ok: true, value: 20 });
  });

  it("rejects values outside range", () => {
    expect(parseAgentConfigValue("concurrency_limit", 0)).toEqual({
      ok: false,
      error: expect.stringContaining("at least 1"),
    });
    expect(parseAgentConfigValue("concurrency_limit", 21)).toEqual({
      ok: false,
      error: expect.stringContaining("at most 20"),
    });
  });

  it("rejects non-integer numbers", () => {
    expect(parseAgentConfigValue("concurrency_limit", 1.5)).toEqual({
      ok: false,
      error: expect.stringContaining("whole number"),
    });
  });

  it("rejects non-numbers", () => {
    expect(parseAgentConfigValue("concurrency_limit", "1")).toEqual({
      ok: false,
      error: expect.stringContaining("must be a number"),
    });
  });
});

describe("parseAgentConfigValue — stall_timeout_ms", () => {
  it("accepts the published bounds", () => {
    expect(
      parseAgentConfigValue("stall_timeout_ms", AGENT_CONFIG_LIMITS.stall_timeout_ms.min),
    ).toEqual({
      ok: true,
      value: AGENT_CONFIG_LIMITS.stall_timeout_ms.min,
    });
    expect(
      parseAgentConfigValue("stall_timeout_ms", AGENT_CONFIG_LIMITS.stall_timeout_ms.max),
    ).toEqual({
      ok: true,
      value: AGENT_CONFIG_LIMITS.stall_timeout_ms.max,
    });
  });

  it("rejects negative values like the regression in the ticket", () => {
    expect(parseAgentConfigValue("stall_timeout_ms", -300_000)).toEqual({
      ok: false,
      error: expect.stringContaining("at least"),
    });
  });

  it("rejects values below the minimum", () => {
    expect(parseAgentConfigValue("stall_timeout_ms", 1000)).toEqual({
      ok: false,
      error: expect.stringContaining("at least 30000"),
    });
  });

  it("rejects values above the maximum", () => {
    expect(parseAgentConfigValue("stall_timeout_ms", 5_000_000)).toEqual({
      ok: false,
      error: expect.stringContaining("at most 1800000"),
    });
  });
});

describe("parseAgentConfigValue — max_retries", () => {
  it("accepts 0", () => {
    expect(parseAgentConfigValue("max_retries", 0)).toEqual({ ok: true, value: 0 });
  });

  it("rejects negative", () => {
    expect(parseAgentConfigValue("max_retries", -1)).toEqual({
      ok: false,
      error: expect.stringContaining("at least 0"),
    });
  });

  it("rejects above 10", () => {
    expect(parseAgentConfigValue("max_retries", 11)).toEqual({
      ok: false,
      error: expect.stringContaining("at most 10"),
    });
  });
});

describe("parseAgentConfigValue — agent_provider", () => {
  it("accepts each known provider", () => {
    for (const provider of AGENT_PROVIDERS) {
      expect(parseAgentConfigValue("agent_provider", provider)).toEqual({
        ok: true,
        value: provider,
      });
    }
  });

  it("rejects unknown providers", () => {
    expect(parseAgentConfigValue("agent_provider", "lol")).toEqual({
      ok: false,
      error: expect.stringContaining("must be one of"),
    });
  });
});

describe("parseAgentConfigValue — agent_model", () => {
  it("accepts known Anthropic model ids", () => {
    expect(parseAgentConfigValue("agent_model", "claude-sonnet-4-20250514")).toEqual({
      ok: true,
      value: "claude-sonnet-4-20250514",
    });
  });

  it("accepts Codex / OpenAI ids", () => {
    expect(parseAgentConfigValue("agent_model", "gpt-5-codex")).toEqual({
      ok: true,
      value: "gpt-5-codex",
    });
    expect(parseAgentConfigValue("agent_model", "o3-mini")).toEqual({
      ok: true,
      value: "o3-mini",
    });
  });

  it("rejects garbage values like the ticket regression", () => {
    expect(parseAgentConfigValue("agent_model", "lol")).toEqual({
      ok: false,
      error: expect.stringContaining("must start with"),
    });
  });

  it("rejects empty strings", () => {
    expect(parseAgentConfigValue("agent_model", "")).toEqual({
      ok: false,
      error: expect.stringContaining("Model is required"),
    });
  });

  it("trims whitespace", () => {
    expect(parseAgentConfigValue("agent_model", "  claude-sonnet-4-5  ")).toEqual({
      ok: true,
      value: "claude-sonnet-4-5",
    });
  });

  it("rejects non-strings", () => {
    expect(parseAgentConfigValue("agent_model", 42)).toEqual({
      ok: false,
      error: expect.stringContaining("Model must be a string"),
    });
  });

  it("rejects suspicious characters", () => {
    expect(parseAgentConfigValue("agent_model", "claude-3 sonnet")).toEqual({
      ok: false,
      error: expect.stringContaining("letters, numbers"),
    });
  });

  it("rejects uppercase model ids so the DB CHECK can't desync from the schema", () => {
    expect(parseAgentConfigValue("agent_model", "GPT-5-codex")).toEqual({
      ok: false,
      error: expect.stringContaining("lowercase"),
    });
    expect(parseAgentConfigValue("agent_model", "Claude-Sonnet-4-5")).toEqual({
      ok: false,
      error: expect.stringContaining("lowercase"),
    });
  });
});

describe("modelMatchesProvider", () => {
  it("matches Anthropic-family providers to claude- prefix", () => {
    expect(modelMatchesProvider("anthropic_api", "claude-sonnet-4-5")).toBe(true);
    expect(modelMatchesProvider("claude_code", "claude-haiku-4-5")).toBe(true);
    expect(modelMatchesProvider("anthropic_api", "gpt-5-codex")).toBe(false);
  });

  it("matches Codex to gpt-/o-family prefixes", () => {
    expect(modelMatchesProvider("codex", "gpt-5-codex")).toBe(true);
    expect(modelMatchesProvider("codex", "o3-mini")).toBe(true);
    expect(modelMatchesProvider("codex", "claude-sonnet-4-5")).toBe(false);
  });

  it("does not match uppercase-prefixed model ids — schema and DB CHECK both require lowercase", () => {
    expect(modelMatchesProvider("anthropic_api", "Claude-Sonnet-4-5")).toBe(false);
    expect(modelMatchesProvider("codex", "GPT-5-codex")).toBe(false);
  });
});

describe("isAgentConfigKey / isAgentProvider", () => {
  it("recognises declared keys", () => {
    expect(isAgentConfigKey("concurrency_limit")).toBe(true);
    expect(isAgentConfigKey("totally_fake")).toBe(false);
    expect(isAgentConfigKey(undefined)).toBe(false);
  });

  it("recognises declared providers", () => {
    expect(isAgentProvider("codex")).toBe(true);
    expect(isAgentProvider("claude_code")).toBe(true);
    expect(isAgentProvider("openai")).toBe(false);
  });
});
