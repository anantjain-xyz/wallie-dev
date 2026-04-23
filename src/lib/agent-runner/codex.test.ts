import { describe, expect, it } from "vitest";

import { CodexRunner, parseCodexLine } from "./codex";

describe("CodexRunner", () => {
  it("has the correct provider name", () => {
    const runner = new CodexRunner({ accessToken: "test-token" });
    expect(runner.provider).toBe("codex");
  });

  it("implements the AgentRunner interface", () => {
    const runner = new CodexRunner({ accessToken: "test-token" });
    expect(typeof runner.start).toBe("function");
  });

  it("throws when constructed without an access token", () => {
    expect(() => new CodexRunner({ accessToken: "" })).toThrow(/accessToken/);
  });
});

describe("parseCodexLine", () => {
  it("parses text events", () => {
    expect(parseCodexLine('{"type":"text","text":"hello"}')).toEqual({
      type: "text",
      text: "hello",
    });
  });

  it("parses assistant messages as text", () => {
    expect(parseCodexLine('{"type":"message","role":"assistant","content":"hi"}')).toEqual({
      type: "text",
      text: "hi",
    });
  });

  it("parses tool calls", () => {
    expect(
      parseCodexLine('{"type":"tool_call","name":"read_file","arguments":{"path":"a.ts"}}'),
    ).toEqual({
      type: "tool_use",
      tool: "read_file",
      input: '{"path":"a.ts"}',
    });
  });

  it("parses result events as completion", () => {
    expect(parseCodexLine('{"type":"result","summary":"done"}')).toEqual({
      type: "completion",
      taskComplete: true,
      summary: "done",
    });
  });

  it("falls back to raw text for unknown JSON shapes", () => {
    expect(parseCodexLine("plain output line")).toEqual({
      type: "text",
      text: "plain output line",
    });
  });

  it("returns null for empty lines", () => {
    expect(parseCodexLine("")).toBeNull();
    expect(parseCodexLine("   ")).toBeNull();
  });
});
