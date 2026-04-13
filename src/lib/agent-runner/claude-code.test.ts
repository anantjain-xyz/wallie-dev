import { describe, expect, it } from "vitest";

import { ClaudeCodeRunner } from "./claude-code";

describe("ClaudeCodeRunner", () => {
  it("has the correct provider name", () => {
    const runner = new ClaudeCodeRunner();
    expect(runner.provider).toBe("claude-code");
  });

  it("implements the AgentRunner interface", () => {
    const runner = new ClaudeCodeRunner();
    expect(typeof runner.start).toBe("function");
  });
});
