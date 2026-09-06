import { describe, expect, it } from "vitest";

import {
  AGENT_CONFIG_LIMITS,
  AGENT_EFFORT_LEVELS,
  AGENT_PROVIDERS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  RECOMMENDED_AGENT_EFFORT,
  RECOMMENDED_AGENT_MODELS,
  STALL_TIMEOUT_MINUTE_LIMITS,
  agentProviderSupportsEffort,
  formatStallTimeoutMinutes,
  getRecommendedAgentConfigDefault,
  getRecommendedAgentModel,
  isAgentConfigKey,
  isAgentEffort,
  isAgentProvider,
  modelMatchesProvider,
  normalizeAgentProviderName,
  OPENCODE_ZEN_PROVIDER_ID,
  parseAgentConfigValue,
  parseOpenCodeModelId,
  parseOpenCodeProviderId,
  parseStallTimeoutMinutes,
  stallTimeoutMinutesToMs,
  stallTimeoutMsToMinutes,
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

describe("stall timeout minutes ↔ milliseconds", () => {
  it("exposes minute bounds derived from the millisecond limits", () => {
    expect(STALL_TIMEOUT_MINUTE_LIMITS.min).toBe(0.5);
    expect(STALL_TIMEOUT_MINUTE_LIMITS.max).toBe(30);
  });

  it("round-trips the recommended default (900000 ms ⇄ 15 minutes)", () => {
    expect(stallTimeoutMsToMinutes(900_000)).toBe(15);
    expect(formatStallTimeoutMinutes(900_000)).toBe("15");
    expect(stallTimeoutMinutesToMs(15)).toBe(900_000);
  });

  it("round-trips the published bounds", () => {
    expect(formatStallTimeoutMinutes(AGENT_CONFIG_LIMITS.stall_timeout_ms.min)).toBe("0.5");
    expect(formatStallTimeoutMinutes(AGENT_CONFIG_LIMITS.stall_timeout_ms.max)).toBe("30");
    expect(stallTimeoutMinutesToMs(0.5)).toBe(AGENT_CONFIG_LIMITS.stall_timeout_ms.min);
    expect(stallTimeoutMinutesToMs(30)).toBe(AGENT_CONFIG_LIMITS.stall_timeout_ms.max);
  });
});

describe("parseStallTimeoutMinutes", () => {
  it("accepts the minute bounds and returns milliseconds", () => {
    expect(parseStallTimeoutMinutes(STALL_TIMEOUT_MINUTE_LIMITS.min)).toEqual({
      ok: true,
      value: AGENT_CONFIG_LIMITS.stall_timeout_ms.min,
    });
    expect(parseStallTimeoutMinutes(STALL_TIMEOUT_MINUTE_LIMITS.max)).toEqual({
      ok: true,
      value: AGENT_CONFIG_LIMITS.stall_timeout_ms.max,
    });
    expect(parseStallTimeoutMinutes(15)).toEqual({ ok: true, value: 900_000 });
  });

  it("reports minute-framed errors below and above the range", () => {
    expect(parseStallTimeoutMinutes(0.25)).toEqual({
      ok: false,
      error: expect.stringContaining("at least 0.5 minutes"),
    });
    expect(parseStallTimeoutMinutes(45)).toEqual({
      ok: false,
      error: expect.stringContaining("at most 30 minutes"),
    });
  });

  it("rejects non-numbers", () => {
    expect(parseStallTimeoutMinutes("15")).toEqual({
      ok: false,
      error: expect.stringContaining("must be a number"),
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
      error: "Provider must be one of: codex, claude-code, cursor, opencode.",
    });
  });
});

describe("provider-specific recommended defaults", () => {
  it("uses provider-specific recommended models", () => {
    expect(getRecommendedAgentModel("codex")).toBe("gpt-5.6-sol");
    expect(getRecommendedAgentModel("claude-code")).toBe("claude-opus-4-8[1m]");
    expect(getRecommendedAgentModel("cursor")).toBe("auto");
    expect(getRecommendedAgentModel("opencode")).toBe("opencode/gpt-5.6-sol");
    expect(RECOMMENDED_AGENT_MODELS).toEqual({
      codex: "gpt-5.6-sol",
      "claude-code": "claude-opus-4-8[1m]",
      cursor: "auto",
      opencode: "opencode/gpt-5.6-sol",
    });
  });

  it("keeps the public agent config default provider on Codex", () => {
    expect(RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider).toBe("codex");
    expect(RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_model).toBe("gpt-5.6-sol");
    expect(RECOMMENDED_AGENT_CONFIG_DEFAULTS.stall_timeout_ms).toBe(900_000);
    expect(getRecommendedAgentConfigDefault("agent_model", "claude-code")).toBe(
      "claude-opus-4-8[1m]",
    );
  });

  it("uses extra-high effort by default", () => {
    expect(RECOMMENDED_AGENT_EFFORT).toBe("xhigh");
    expect(RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_effort).toBe("xhigh");
  });
});

describe("parseAgentConfigValue — agent_effort", () => {
  it("accepts every supported effort level", () => {
    for (const effort of AGENT_EFFORT_LEVELS) {
      expect(parseAgentConfigValue("agent_effort", effort)).toEqual({ ok: true, value: effort });
      expect(isAgentEffort(effort)).toBe(true);
    }
  });

  it("rejects unsupported effort levels", () => {
    expect(parseAgentConfigValue("agent_effort", "ultra")).toEqual({
      ok: false,
      error: "Effort must be one of: low, medium, high, xhigh, max.",
    });
    expect(isAgentEffort("ultra")).toBe(false);
  });
});

describe("agentProviderSupportsEffort", () => {
  it("advertises effort only for providers that accept it", () => {
    expect(agentProviderSupportsEffort("codex")).toBe(true);
    expect(agentProviderSupportsEffort("claude-code")).toBe(true);
    expect(agentProviderSupportsEffort("cursor")).toBe(false);
    expect(agentProviderSupportsEffort("opencode")).toBe(false);
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

  it("accepts Cursor Auto catalog ids and existing Cursor-prefixed models", () => {
    expect(parseAgentConfigValue("agent_model", "auto")).toEqual({
      ok: true,
      value: "auto",
    });
    expect(parseAgentConfigValue("agent_model", "auto-smart")).toEqual({
      ok: true,
      value: "auto-smart",
    });
    expect(parseAgentConfigValue("agent_model", "composer-2")).toEqual({
      ok: true,
      value: "composer-2",
    });
  });

  it("accepts lowercase OpenCode provider/model identifiers", () => {
    expect(parseAgentConfigValue("agent_model", "opencode/gpt-5.6-sol")).toEqual({
      ok: true,
      value: "opencode/gpt-5.6-sol",
    });
    expect(parseAgentConfigValue("agent_model", "opencode-go/glm-5.3")).toEqual({
      ok: true,
      value: "opencode-go/glm-5.3",
    });
    expect(parseAgentConfigValue("agent_model", "anthropic/claude-sonnet-4-5")).toEqual({
      ok: true,
      value: "anthropic/claude-sonnet-4-5",
    });
    expect(parseAgentConfigValue("agent_model", "openrouter/anthropic/claude-sonnet-4")).toEqual({
      ok: true,
      value: "openrouter/anthropic/claude-sonnet-4",
    });
    expect(parseAgentConfigValue("agent_model", "OpenCode/gpt-5.6-sol")).toEqual({
      ok: false,
      error: expect.stringContaining("lowercase"),
    });
    expect(parseAgentConfigValue("agent_model", "opencode-go/GLM-5.3")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(parseAgentConfigValue("agent_model", "opencode-go/glm-5.3/")).toEqual({
      ok: false,
      error: expect.any(String),
    });
    expect(parseAgentConfigValue("agent_model", "opencode-go//glm-5.3")).toEqual({
      ok: false,
      error: expect.any(String),
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

  it("never matches slashed ids to Codex or Claude Code", () => {
    expect(modelMatchesProvider("codex", "gpt-custom/foo")).toBe(false);
    expect(modelMatchesProvider("claude-code", "claude-custom/foo")).toBe(false);
    expect(modelMatchesProvider("cursor", "gpt-5.5/gpt-5.5")).toBe(false);
  });

  it("matches Cursor Auto catalog ids", () => {
    expect(modelMatchesProvider("cursor", "auto")).toBe(true);
    expect(modelMatchesProvider("cursor", "auto-smart")).toBe(true);
    expect(modelMatchesProvider("cursor", "composer-2")).toBe(true);
  });

  it("matches OpenCode to lowercase provider/model ids only", () => {
    expect(modelMatchesProvider("opencode", "opencode/gpt-5.6-sol")).toBe(true);
    expect(modelMatchesProvider("opencode", "opencode-go/glm-5.3")).toBe(true);
    expect(modelMatchesProvider("opencode", "anthropic/claude-sonnet-4-5")).toBe(true);
    expect(modelMatchesProvider("opencode", "openrouter/anthropic/claude-sonnet-4")).toBe(true);
    expect(modelMatchesProvider("opencode", "gpt-5.6-sol")).toBe(false);
    expect(modelMatchesProvider("opencode", "OpenCode/gpt-5.6-sol")).toBe(false);
    expect(modelMatchesProvider("opencode", "opencode-go/glm-5.3/")).toBe(false);
    expect(modelMatchesProvider("claude-code", "anthropic/claude-sonnet-4-5")).toBe(false);
  });
});

describe("normalizeAgentProviderName", () => {
  it("rewrites underscore aliases to canonical dashed providers", () => {
    expect(normalizeAgentProviderName("claude_code")).toBe("claude-code");
  });

  it("passes canonical providers through unchanged", () => {
    expect(normalizeAgentProviderName("codex")).toBe("codex");
    expect(normalizeAgentProviderName("claude-code")).toBe("claude-code");
    expect(normalizeAgentProviderName("opencode")).toBe("opencode");
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
    expect(isAgentProvider("opencode")).toBe(true);
    expect(isAgentProvider("openai")).toBe(false);
  });
});

describe("parseOpenCodeModelId", () => {
  it("splits at the first slash and accepts multi-slash model remainders", () => {
    expect(parseOpenCodeModelId("opencode/gpt-5.6-sol")).toEqual({
      providerId: OPENCODE_ZEN_PROVIDER_ID,
      modelId: "gpt-5.6-sol",
    });
    expect(parseOpenCodeModelId("opencode-go/glm-5.3")).toEqual({
      providerId: "opencode-go",
      modelId: "glm-5.3",
    });
    expect(parseOpenCodeModelId("openrouter/anthropic/claude-sonnet-4")).toEqual({
      providerId: "openrouter",
      modelId: "anthropic/claude-sonnet-4",
    });
  });

  it("rejects empty or uppercase segments", () => {
    expect(parseOpenCodeModelId("opencode-go/glm-5.3/")).toBeNull();
    expect(parseOpenCodeModelId("OpenRouter/gpt-5")).toBeNull();
    expect(parseOpenCodeModelId("gpt-5.6-sol")).toBeNull();
  });
});

describe("parseOpenCodeProviderId", () => {
  it("accepts a lowercase slug and rejects the reserved Zen prefix", () => {
    expect(parseOpenCodeProviderId("opencode-go")).toEqual({ ok: true, value: "opencode-go" });
    expect(parseOpenCodeProviderId("  openrouter  ")).toEqual({ ok: true, value: "openrouter" });
    expect(parseOpenCodeProviderId(OPENCODE_ZEN_PROVIDER_ID)).toEqual({
      ok: false,
      error: expect.stringContaining("reserved"),
    });
  });

  it("rejects malformed slugs", () => {
    expect(parseOpenCodeProviderId("")).toEqual({
      ok: false,
      error: "Provider id is required.",
    });
    expect(parseOpenCodeProviderId("OpenRouter")).toEqual({
      ok: false,
      error: expect.stringContaining("lowercase slug"),
    });
    expect(parseOpenCodeProviderId("open/router")).toEqual({
      ok: false,
      error: expect.stringContaining("lowercase slug"),
    });
    expect(parseOpenCodeProviderId(12)).toEqual({
      ok: false,
      error: "Provider id must be a string.",
    });
  });
});
