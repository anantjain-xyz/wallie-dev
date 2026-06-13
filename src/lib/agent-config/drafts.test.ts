import { describe, expect, it } from "vitest";

import {
  agentConfigValueToDraft,
  applyAgentConfigDraftChange,
  parseAgentConfigDraft,
} from "./drafts";

describe("agentConfigValueToDraft", () => {
  it("renders the stored stall timeout (ms) as minutes for the UI", () => {
    expect(agentConfigValueToDraft("stall_timeout_ms", 900_000)).toBe("15");
    expect(agentConfigValueToDraft("stall_timeout_ms", 30_000)).toBe("0.5");
    expect(agentConfigValueToDraft("stall_timeout_ms", 1_800_000)).toBe("30");
  });

  it("passes other keys through unchanged", () => {
    expect(agentConfigValueToDraft("concurrency_limit", 1)).toBe("1");
    expect(agentConfigValueToDraft("agent_model", "gpt-5.5")).toBe("gpt-5.5");
    expect(agentConfigValueToDraft("max_retries", undefined)).toBe("");
  });
});

describe("parseAgentConfigDraft — stall_timeout_ms", () => {
  it("parses a minutes draft into the stored millisecond value", () => {
    expect(parseAgentConfigDraft("stall_timeout_ms", "number", "15")).toEqual({
      ok: true,
      value: 900_000,
    });
    expect(parseAgentConfigDraft("stall_timeout_ms", "number", "0.5")).toEqual({
      ok: true,
      value: 30_000,
    });
  });

  it("round-trips a saved value back to the same minutes draft", () => {
    const parsed = parseAgentConfigDraft("stall_timeout_ms", "number", "15");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(agentConfigValueToDraft("stall_timeout_ms", parsed.value)).toBe("15");
    }
  });

  it("reports minute-framed range errors", () => {
    expect(parseAgentConfigDraft("stall_timeout_ms", "number", "0.1")).toEqual({
      ok: false,
      error: expect.stringContaining("at least 0.5 minutes"),
    });
    expect(parseAgentConfigDraft("stall_timeout_ms", "number", "60")).toEqual({
      ok: false,
      error: expect.stringContaining("at most 30 minutes"),
    });
  });

  it("rejects empty and non-numeric drafts", () => {
    expect(parseAgentConfigDraft("stall_timeout_ms", "number", "  ")).toEqual({
      ok: false,
      error: "Enter a number.",
    });
    expect(parseAgentConfigDraft("stall_timeout_ms", "number", "soon")).toEqual({
      ok: false,
      error: "Must be a number.",
    });
  });
});

describe("applyAgentConfigDraftChange", () => {
  it("pairs a provider change with the provider's recommended model", () => {
    const drafts = {
      agent_provider: "codex",
      agent_model: "gpt-5.5",
      concurrency_limit: "1",
      stall_timeout_ms: "15",
      max_retries: "3",
    };
    expect(applyAgentConfigDraftChange(drafts, "agent_provider", "claude-code")).toMatchObject({
      agent_provider: "claude-code",
      agent_model: "claude-opus-4-7[1m]",
    });
  });
});
