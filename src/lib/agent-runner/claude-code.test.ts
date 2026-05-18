import { describe, expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { ClaudeCodeRunner, parseStreamJsonLine } from "./claude-code";

describe("ClaudeCodeRunner", () => {
  it("has the correct provider name", () => {
    const runner = new ClaudeCodeRunner();
    expect(runner.provider).toBe("claude-code");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("implements the AgentRunner interface", () => {
    const runner = new ClaudeCodeRunner();
    expect(typeof runner.start).toBe("function");
  });

  it("throws when started without a sandbox", async () => {
    const runner = new ClaudeCodeRunner();
    const iter = runner.start({ sessionId: "s", prompt: "p" });
    await expect(
      (async () => {
        for await (const _ of iter) {
          void _;
        }
      })(),
    ).rejects.toThrow(/requires a sandbox/);
  });

  it("streams parsed events and bakes the session id into the completion summary", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data:
          `{"type":"assistant","session_id":"sess-42",` +
          `"message":{"content":[{"type":"text","text":"working"}]}}\n`,
        stream: "stdout",
      },
      {
        data: `{"type":"result","session_id":"sess-42","result":"done"}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new ClaudeCodeRunner();
    const events = [];
    for await (const ev of runner.start({
      sessionId: "s1",
      sandbox,
      prompt: "Make it so",
      continueSessionId: "prev-session",
    })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: "text", text: "working" },
      { type: "completion", taskComplete: true, summary: "done" },
      { type: "completion", taskComplete: true, summary: "Claude Code session: sess-42" },
    ]);

    expect(await sandbox.readFile("/vercel/sandbox/.wallie-prompt.txt")).toBe("Make it so");

    const [call] = sandbox.calls;
    expect(call.cmd).toBe("bash");
    expect(call.args[0]).toBe("-lc");
    expect(call.args[1]).toContain("'--model' 'claude-opus-4-7[1m]'");
    expect(call.args[1]).toContain("'--effort' 'xhigh'");
    expect(call.args[1]).toContain("'--continue' 'prev-session'");
    expect(call.args[1]).toContain("< '/vercel/sandbox/.wallie-prompt.txt'");
  });

  it("emits an error event when the CLI exits non-zero", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [{ data: "boom\n", stream: "stderr" }], { exitCode: 2 });

    const runner = new ClaudeCodeRunner();
    const events = [];
    for await (const ev of runner.start({ sessionId: "s", sandbox, prompt: "p" })) {
      events.push(ev);
    }

    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain("exited with code 2");
  });
});

describe("parseStreamJsonLine", () => {
  it("parses an assistant text block", () => {
    expect(
      parseStreamJsonLine(
        `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`,
      ),
    ).toEqual({ type: "text", text: "hi" });
  });

  it("parses an assistant tool_use block", () => {
    expect(
      parseStreamJsonLine(
        `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"bash","input":{"cmd":"ls"}}]}}`,
      ),
    ).toEqual({ type: "tool_use", tool: "bash", input: `{"cmd":"ls"}` });
  });

  it("parses a result event", () => {
    expect(parseStreamJsonLine(`{"type":"result","result":"summary here"}`)).toEqual({
      type: "completion",
      taskComplete: true,
      summary: "summary here",
    });
  });

  it("parses a content_block_delta", () => {
    expect(
      parseStreamJsonLine(`{"type":"content_block_delta","delta":{"text":"partial"}}`),
    ).toEqual({ type: "text", text: "partial" });
  });

  it("falls back to raw text for non-JSON", () => {
    expect(parseStreamJsonLine("plain output")).toEqual({ type: "text", text: "plain output" });
  });
});
