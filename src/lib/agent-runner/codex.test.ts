import { describe, expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { CodexRunner, parseCodexLine } from "./codex";

describe("CodexRunner", () => {
  it("has the correct provider name", () => {
    const runner = new CodexRunner({ accessToken: "test-token" });
    expect(runner.provider).toBe("codex");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("implements the AgentRunner interface", () => {
    const runner = new CodexRunner({ accessToken: "test-token" });
    expect(typeof runner.start).toBe("function");
  });

  it("throws when constructed without an access token", () => {
    expect(() => new CodexRunner({ accessToken: "" })).toThrow(/accessToken/);
  });

  it("throws when started without a sandbox", async () => {
    const runner = new CodexRunner({ accessToken: "tok" });
    const iter = runner.start({ sessionId: "s", prompt: "p" });
    await expect(
      (async () => {
        for await (const _ of iter) {
          void _;
        }
      })(),
    ).rejects.toThrow(/requires a sandbox/);
  });

  it("writes auth.json + prompt file and streams events from scripted stdout", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (c) => c.cmd === "bash",
      [
        { data: `{"type":"text","text":"thinking..."}\n`, stream: "stdout" },
        {
          data: `{"type":"tool_call","name":"read_file","arguments":{"path":"a.ts"}}\n`,
          stream: "stdout",
        },
        { data: `{"type":"result","summary":"all done"}\n`, stream: "stdout" },
      ],
    );

    const runner = new CodexRunner({ accessToken: "tok" });
    const events = [];
    for await (const ev of runner.start({
      sessionId: "s1",
      sandbox,
      prompt: "Hello Codex",
    })) {
      events.push(ev);
    }

    expect(events).toEqual([
      { type: "text", text: "thinking..." },
      { type: "tool_use", tool: "read_file", input: '{"path":"a.ts"}' },
      { type: "completion", taskComplete: true, summary: "all done" },
      { type: "completion", taskComplete: true, summary: "Codex session completed" },
    ]);

    // auth.json and prompt must land in the sandbox.
    expect(await sandbox.readFile("/vercel/sandbox/.codex/auth.json")).toContain(
      `"access_token":"tok"`,
    );
    expect(await sandbox.readFile("/vercel/sandbox/.wallie-prompt.txt")).toBe("Hello Codex");

    // CLI invocation uses bash -lc to redirect the prompt file as stdin.
    expect(sandbox.calls).toHaveLength(1);
    const [call] = sandbox.calls;
    expect(call.cmd).toBe("bash");
    expect(call.args[0]).toBe("-lc");
    expect(call.args[1]).toContain("codex 'exec' '--model' 'gpt-5.5'");
    expect(call.args[1]).toContain(`'-c' 'model_reasoning_effort="xhigh"'`);
    expect(call.args[1]).toContain("< '/vercel/sandbox/.wallie-prompt.txt'");
    expect(call.opts.env).toMatchObject({ CODEX_HOME: "/vercel/sandbox/.codex" });
  });

  it("emits an error event when the CLI exits non-zero", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [{ data: "fatal: auth failed\n", stream: "stderr" }], {
      exitCode: 1,
    });

    const runner = new CodexRunner({ accessToken: "tok" });
    const events = [];
    for await (const ev of runner.start({ sessionId: "s", sandbox, prompt: "p" })) {
      events.push(ev);
    }

    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain("exited with code 1");
    expect((events[0] as { message: string }).message).toContain("auth failed");
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
