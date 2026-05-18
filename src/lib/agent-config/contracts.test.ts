import { describe, expect, it } from "vitest";

import {
  AGENT_CONFIG_LIMITS,
  AGENT_PROVIDERS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  RECOMMENDED_AGENT_MODELS,
  RECOMMENDED_CLAUDE_CODE_EFFORT,
  RECOMMENDED_CODEX_REASONING_EFFORT,
  getRecommendedAgentConfigDefault,
  getRecommendedAgentModel,
  isAgentConfigKey,
  isAgentProvider,
  modelMatchesProvider,
  normalizeAgentProviderName,
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
  it("accepts each canonical provider", () => {
    for (const provider of AGENT_PROVIDERS) {
      expect(parseAgentConfigValue("agent_provider", provider)).toEqual({
        ok: true,
        value: provider,
      });
    }
  });

  it("normalizes legacy underscore aliases to canonical providers", () => {
    expect(parseAgentConfigValue("agent_provider", "claude_code")).toEqual({
      ok: true,
      value: "claude-code",
    });
  });

  it("rejects unknown providers", () => {
    expect(parseAgentConfigValue("agent_provider", "lol")).toEqual({
      ok: false,
      error: "Provider must be one of: codex, claude-code.",
    });
  });
});

describe("provider-specific recommended defaults", () => {
  it("uses GPT-5.5 for Codex and Opus 4.7 1M for Claude Code", () => {
    expect(getRecommendedAgentModel("codex")).toBe("gpt-5.5");
    expect(getRecommendedAgentModel("claude-code")).toBe("claude-opus-4-7[1m]");
    expect(RECOMMENDED_AGENT_MODELS).toEqual({
      codex: "gpt-5.5",
      "claude-code": "claude-opus-4-7[1m]",
    });
  });

  it("keeps the public agent config default provider on Codex", () => {
    expect(RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider).toBe("codex");
    expect(RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_model).toBe("gpt-5.5");
    expect(getRecommendedAgentConfigDefault("agent_model", "claude-code")).toBe(
      "claude-opus-4-7[1m]",
    );
  });

  it("uses extra-high effort for both CLI providers", () => {
    expect(RECOMMENDED_CODEX_REASONING_EFFORT).toBe("xhigh");
    expect(RECOMMENDED_CLAUDE_CODE_EFFORT).toBe("xhigh");
  });
});

describe("parseAgentConfigValue — agent_model", () => {
  it("accepts known Claude model ids", () => {
    expect(parseAgentConfigValue("agent_model", "claude-sonnet-4-20250514")).toEqual({
      ok: true,
      value: "claude-sonnet-4-20250514",
    });
    expect(parseAgentConfigValue("agent_model", "claude-opus-4-7[1m]")).toEqual({
      ok: true,
      value: "claude-opus-4-7[1m]",
    });
  });

  it("accepts Codex / OpenAI ids", () => {
    expect(parseAgentConfigValue("agent_model", "gpt-5.5")).toEqual({
      ok: true,
      value: "gpt-5.5",
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
    expect(parseAgentConfigValue("agent_model", "claude-opus-4-7[2m]")).toEqual({
      ok: false,
      error: expect.stringContaining("optional Claude [1m] suffix"),
    });
    expect(parseAgentConfigValue("agent_model", "gpt-5.5[1m]")).toEqual({
      ok: false,
      error: expect.stringContaining("optional Claude [1m] suffix"),
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
  it("matches Claude Code to the claude- prefix", () => {
    expect(modelMatchesProvider("claude-code", "claude-haiku-4-5")).toBe(true);
    expect(modelMatchesProvider("claude-code", "claude-opus-4-7[1m]")).toBe(true);
    expect(modelMatchesProvider("claude-code", "gpt-5-codex")).toBe(false);
  });

  it("matches Codex to gpt-/o-family prefixes", () => {
    expect(modelMatchesProvider("codex", "gpt-5.5")).toBe(true);
    expect(modelMatchesProvider("codex", "o3-mini")).toBe(true);
    expect(modelMatchesProvider("codex", "claude-sonnet-4-5")).toBe(false);
    expect(modelMatchesProvider("codex", "gpt-5.5[1m]")).toBe(false);
  });

  it("does not match uppercase-prefixed model ids — schema and DB CHECK both require lowercase", () => {
    expect(modelMatchesProvider("claude-code", "Claude-Sonnet-4-5")).toBe(false);
    expect(modelMatchesProvider("codex", "GPT-5-codex")).toBe(false);
  });
});

describe("normalizeAgentProviderName", () => {
  it("rewrites underscore aliases to canonical dashed providers", () => {
    expect(normalizeAgentProviderName("claude_code")).toBe("claude-code");
  });

  it("passes canonical providers through unchanged", () => {
    expect(normalizeAgentProviderName("codex")).toBe("codex");
    expect(normalizeAgentProviderName("claude-code")).toBe("claude-code");
  });

  it("returns null for unset or unknown providers", () => {
    expect(normalizeAgentProviderName(undefined)).toBeNull();
    expect(normalizeAgentProviderName("openai")).toBeNull();
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
    expect(isAgentProvider("claude-code")).toBe(true);
    expect(isAgentProvider("openai")).toBe(false);
  });
});
