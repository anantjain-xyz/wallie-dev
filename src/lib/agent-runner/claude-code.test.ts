import { describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";
import { harnessPath, runnerCalls } from "./test-helpers";

import { ClaudeCodeRunner, parseStreamJsonLine } from "./claude-code";

const anthropicCredential = { secret: "sk-ant-test" };

describe("ClaudeCodeRunner", () => {
  it("has the correct provider name", () => {
    const runner = new ClaudeCodeRunner({ credential: anthropicCredential });
    expect(runner.provider).toBe("claude-code");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("implements the AgentRunner interface", () => {
    const runner = new ClaudeCodeRunner({ credential: anthropicCredential });
    expect(typeof runner.start).toBe("function");
  });

  it.each([{}, { credential: { secret: "" } }])(
    "rejects missing eager and lazy credentials (%j)",
    (options) => {
      expect(() => new ClaudeCodeRunner(options)).toThrow(/Anthropic API key/);
    },
  );

  it("throws when started without a sandbox", async () => {
    const runner = new ClaudeCodeRunner({ credential: anthropicCredential });
    const iter = runner.start({ sessionId: "s", prompt: "p" });
    await expect(
      (async () => {
        for await (const _ of iter) {
          void _;
        }
      })(),
    ).rejects.toThrow(/requires a sandbox/);
  });

  it("streams parsed events and emits one successful terminal deliverable", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data:
          `{"type":"assistant","session_id":"sess-42",` +
          `"message":{"content":[{"type":"text","text":"working"}]}}\n`,
        stream: "stdout",
      },
      {
        data: `{"type":"result","subtype":"success","session_id":"sess-42","result":"done"}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new ClaudeCodeRunner({
      credential: anthropicCredential,
      effort: "max",
      maxTurns: 12,
    });
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
      { type: "completion", taskComplete: true, summary: "done", finalOutput: "done" },
    ]);

    expect(await sandbox.readFile(harnessPath(sandbox, "prompt.txt"))).toBe("Make it so");

    const [call] = runnerCalls(sandbox);
    expect(call.cmd).toBe("bash");
    expect(call.args[0]).toBe("-lc");
    expect(call.args[1]).toContain("'--model' 'claude-opus-4-8[1m]'");
    expect(call.args[1]).toContain("'--effort' 'max'");
    expect(call.args[1]).toContain("'--max-turns' '12'");
    expect(call.args[1]).toContain("'--bare'");
    expect(call.args[1]).toContain("'--add-dir' '/vercel/sandbox'");
    expect(call.args[1]).toContain("'--no-chrome'");
    expect(call.args[1]).toContain("'--strict-mcp-config'");
    expect(call.args[1]).toContain(`'--mcp-config' '{"mcpServers":{}}'`);
    expect(call.args[1]).toContain("'--permission-mode' 'bypassPermissions'");
    expect(call.args[1]).toContain("'--resume' 'prev-session'");
    expect(call.args[1]).not.toContain("'--stdin'");
    expect(call.args[1]).toContain(`< '${harnessPath(sandbox, "prompt.txt")}'`);
    expect(call.opts.env).toMatchObject({
      ANTHROPIC_API_KEY: "sk-ant-test",
      CI: "1",
      GIT_AUTHOR_EMAIL: "287554934+wallie-dev[bot]@users.noreply.github.com",
      GIT_AUTHOR_NAME: "wallie-dev[bot]",
      GIT_COMMITTER_EMAIL: "287554934+wallie-dev[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "wallie-dev[bot]",
    });
  });

  it("does not load or inject credentials while a prompt write is pending", async () => {
    const sandbox = new FakeSandbox();
    let promptStarted!: () => void;
    let finishPrompt!: () => void;
    const started = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finishPrompt = resolve;
    });
    const writeFile = sandbox.writeFile.bind(sandbox);
    vi.spyOn(sandbox, "writeFile").mockImplementation(async (...args) => {
      promptStarted();
      await pending;
      await writeFile(...args);
    });
    let activeMember = true;
    const loadCredential = vi.fn(async () => {
      if (!activeMember) throw new Error("Session creator is no longer active");
      return { secret: "fresh-anthropic-key" };
    });
    const readOriginalSecret = vi.fn(() => "stale-anthropic-key");
    const runner = new ClaudeCodeRunner({
      credential: {
        get secret() {
          return readOriginalSecret();
        },
      },
      loadCredential,
    });
    const consume = async () => {
      for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
        void event;
      }
    };
    const run = consume();
    await started;
    expect(loadCredential).not.toHaveBeenCalled();
    expect(readOriginalSecret).not.toHaveBeenCalled();
    expect(runnerCalls(sandbox)).toHaveLength(0);

    activeMember = false;
    const rejected = expect(run).rejects.toThrow(/no longer active/);
    finishPrompt();
    await rejected;

    expect(loadCredential).toHaveBeenCalledOnce();
    expect(readOriginalSecret).not.toHaveBeenCalled();
    expect(runnerCalls(sandbox)).toHaveLength(0);
    expect([...sandbox.files.values()].map((file) => file.data.toString())).toEqual(["p"]);
  });

  it("loads the latest key after every prompt write and injects only that key", async () => {
    const sandbox = new FakeSandbox();
    let secret = "fresh-anthropic-key";
    const loadCredential = vi.fn(async () => {
      expect(sandbox.files.has(harnessPath(sandbox, "prompt.txt"))).toBe(true);
      return { secret };
    });
    const runner = new ClaudeCodeRunner({ loadCredential });

    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      void event;
    }
    secret = "newer-anthropic-key";
    for await (const event of runner.start({ prompt: "p2", sandbox, sessionId: "s" })) {
      void event;
    }

    expect(loadCredential).toHaveBeenCalledTimes(2);
    expect(runnerCalls(sandbox)).toHaveLength(2);
    expect(runnerCalls(sandbox)[0]?.opts.env).toMatchObject({
      ANTHROPIC_API_KEY: "fresh-anthropic-key",
    });
    expect(runnerCalls(sandbox)[1]?.opts.env).toMatchObject({
      ANTHROPIC_API_KEY: "newer-anthropic-key",
    });
  });

  it("emits an error event when the CLI exits non-zero", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [{ data: "boom\n", stream: "stderr" }], { exitCode: 2 });

    const runner = new ClaudeCodeRunner({ credential: anthropicCredential });
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
    ).toEqual([{ type: "text", text: "hi" }]);
  });

  it("parses an assistant tool_use block", () => {
    expect(
      parseStreamJsonLine(
        `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"bash","input":{"cmd":"ls"}}]}}`,
      ),
    ).toEqual([{ type: "tool_use", tool: "bash", input: `{"cmd":"ls"}` }]);
  });

  it("parses a result event", () => {
    expect(
      parseStreamJsonLine(`{"type":"result","subtype":"success","result":"summary here"}`),
    ).toEqual([
      {
        type: "completion",
        taskComplete: true,
        summary: "summary here",
        finalOutput: "summary here",
      },
    ]);
  });

  it("parses a content_block_delta", () => {
    expect(
      parseStreamJsonLine(`{"type":"content_block_delta","delta":{"text":"partial"}}`),
    ).toEqual([{ type: "text", text: "partial" }]);
  });

  it("falls back to raw text for non-JSON", () => {
    expect(parseStreamJsonLine("plain output")).toEqual([{ type: "text", text: "plain output" }]);
  });

  it("preserves interleaved text and parallel tool blocks in a response", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Inspecting" },
              { type: "tool_use", name: "Read", input: { file: "a.ts" } },
              { type: "tool_use", name: "Read", input: { file: "b.ts" } },
              { type: "text", text: "All done" },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "text", text: "Inspecting" },
      { type: "tool_use", tool: "Read", input: '{"file":"a.ts"}' },
      { type: "tool_use", tool: "Read", input: '{"file":"b.ts"}' },
      { type: "text", text: "All done" },
    ]);
  });
});

describe("Claude Code terminal outcomes", () => {
  it.each([
    { subtype: "error_max_turns", is_error: true, errors: ["Turn budget exhausted"] },
    { subtype: "error_during_execution", is_error: true },
    { subtype: "success", is_error: true },
    { subtype: "unrecognized" },
  ])("rejects unsuccessful result %j even with partial text and exit zero", async (result) => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        stream: "stdout",
        data: [
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "Partial work" }] },
          }),
          JSON.stringify({ type: "result", result: "Partial output", ...result }),
        ].join("\n"),
      },
    ]);
    const events = [];
    for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
      sandbox,
      sessionId: "s",
      prompt: "p",
    }))
      events.push(event);
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect(events.some((event) => event.type === "completion")).toBe(false);
    expect(runnerCalls(sandbox)[0].args[1]).toContain("'--max-turns' '5'");
  });

  it.each([0, 1])("does not synthesize success without a result (exit %i)", async (exitCode) => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [{ stream: "stdout", data: "Partial text" }], { exitCode });
    const events = [];
    for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
      sandbox,
      sessionId: "s",
      prompt: "p",
    }))
      events.push(event);
    expect(events.some((event) => event.type === "completion")).toBe(false);
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("does not emit success when a success result is followed by process failure", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [
        {
          stream: "stdout",
          data: JSON.stringify({ type: "result", subtype: "success", result: "deliverable" }),
        },
      ],
      { exitCode: 2 },
    );
    const events = [];
    for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
      sandbox,
      sessionId: "s",
      prompt: "p",
    }))
      events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: "error" })]);
  });
});
