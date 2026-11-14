import { describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";
import { harnessPath, runnerCalls } from "./test-helpers";

import { ClaudeCodeRunner, parseStreamJsonLine } from "./claude-code";
import type { AgentEvent } from "./types";

const anthropicCredential = { secret: "sk-ant-test" };

async function runClaudeToolRecords(records: unknown[]): Promise<AgentEvent[]> {
  const sandbox = new FakeSandbox();
  const stream = records.map((record) => JSON.stringify(record)).join("\n");
  const midpoint = Math.floor(stream.length / 2);
  sandbox.scriptExec("bash", [
    { stream: "stdout", data: stream.slice(0, midpoint) },
    { stream: "stdout", data: stream.slice(midpoint) },
  ]);
  const events: AgentEvent[] = [];
  for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
    sessionId: "tool-capture",
    sandbox,
    prompt: "Inspect the fixture files",
  }))
    events.push(event);
  return events;
}

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
      { type: "progress", text: "working" },
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

  it.each([
    { progress: [] },
    { progress: ["Inspecting the implementation", "Tests are still running"] },
  ])(
    "keeps narration in activity and preserves the entire final result (%j)",
    async ({ progress }) => {
      const finalOutput = `\n# Delivered\n\n${"Validation passed. ".repeat(1_000)}\n\nBlocker: publication requires credentials.  \n\n`;
      const sandbox = new FakeSandbox();
      const records = [
        ...progress.map((text) => ({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        })),
        {
          type: "result",
          subtype: "success",
          result: finalOutput,
          usage: { input_tokens: 12, output_tokens: 34 },
        },
      ];
      sandbox.scriptExec("bash", [
        { stream: "stdout", data: records.map((record) => JSON.stringify(record)).join("\n") },
      ]);
      const events = [];
      for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
        sandbox,
        sessionId: "final-output",
        prompt: "p",
      }))
        events.push(event);

      expect(events).toEqual([
        ...progress.map((text) => ({ type: "progress", text })),
        {
          type: "completion",
          taskComplete: true,
          summary: finalOutput,
          finalOutput,
          usage: { inputTokens: 12, outputTokens: 34, provenance: "measured" },
        },
      ]);
    },
  );

  it("does not promote assistant narration when a successful result has no final message", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        stream: "stdout",
        data: [
          { type: "assistant", message: { content: [{ type: "text", text: "Still working" }] } },
          { type: "result", subtype: "success", usage: { input_tokens: 12, output_tokens: 3 } },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      },
    ]);
    const events = [];
    for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
      sandbox,
      sessionId: "missing-final",
      prompt: "p",
    }))
      events.push(event);
    expect(events[0]).toEqual({ type: "progress", text: "Still working" });
    expect(events[1]).toMatchObject({
      type: "completion",
      usage: { inputTokens: 12, outputTokens: 3, provenance: "measured" },
    });
    expect(events[1]?.type === "completion" && events[1].finalOutput).toBeUndefined();
  });

  it("preserves substantive partial output alongside a terminal error", async () => {
    const sandbox = new FakeSandbox();
    const partialOutput = "Validation passed. Blocker: publication requires credentials.";
    sandbox.scriptExec("bash", [
      {
        stream: "stdout",
        data: JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: partialOutput,
          errors: ["Provider failed after response"],
        }),
      },
    ]);
    const events = [];
    for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
      sandbox,
      sessionId: "partial-output",
      prompt: "p",
    }))
      events.push(event);
    expect(events).toEqual([
      { type: "progress", text: partialOutput },
      {
        type: "error",
        message: "Claude Code error_during_execution: Provider failed after response",
      },
    ]);
  });

  it("preserves a buffered final result in activity when a later result reports an error", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        stream: "stdout",
        data: [
          {
            type: "result",
            subtype: "success",
            result: "Validation passed. Blocker: release pending.",
            usage: { input_tokens: 12, output_tokens: 8 },
          },
          {
            type: "result",
            subtype: "error_during_execution",
            errors: ["Provider failed after response"],
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      },
    ]);
    const events = [];
    for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
      sandbox,
      sessionId: "late-error",
      prompt: "p",
    }))
      events.push(event);
    expect(events).toEqual([
      { type: "progress", text: "Validation passed. Blocker: release pending." },
      {
        type: "completion",
        taskComplete: false,
        summary: "Claude Code reported usage before an unsuccessful result",
        usage: { inputTokens: 12, outputTokens: 8, provenance: "measured" },
      },
      {
        type: "error",
        message: "Claude Code error_during_execution: Provider failed after response",
      },
    ]);
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

  it("preserves result usage when the CLI exits nonzero after a result", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [
        {
          data: `{"type":"result","subtype":"success","result":"done","usage":{"input_tokens":12,"output_tokens":8},"total_cost_usd":0.25}\n`,
          stream: "stdout",
        },
        { data: "late failure\n", stream: "stderr" },
      ],
      { exitCode: 2 },
    );

    const runner = new ClaudeCodeRunner({ credential: anthropicCredential });
    const events = [];
    for await (const event of runner.start({ sessionId: "s", sandbox, prompt: "p" })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: "progress", text: "done" });
    expect(events[1]).toMatchObject({
      type: "completion",
      taskComplete: false,
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        costUsd: 0.25,
        provenance: "measured",
        costProvenance: "measured",
      },
    });
    expect(events[2]).toMatchObject({ type: "error" });
  });

  it.each([500, 501])(
    "marks stderr clipping at the 500-character boundary (%i)",
    async (length) => {
      const sandbox = new FakeSandbox();
      sandbox.scriptExec("bash", [{ data: "x".repeat(length), stream: "stderr" }], { exitCode: 1 });
      const runner = new ClaudeCodeRunner({ credential: anthropicCredential });
      const events = [];
      for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" }))
        events.push(event);
      expect(events).toEqual([
        {
          type: "error",
          message: `claude CLI exited with code 1: ${"x".repeat(500)}`,
          ...(length > 500 ? { captureTruncated: true } : {}),
        },
      ]);
    },
  );

  it("redacts unknown credential patterns before clipping stderr", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [{ data: `${"x".repeat(490)} sk-${"a".repeat(60)} ${"y".repeat(100)}`, stream: "stderr" }],
      { exitCode: 1 },
    );
    const runner = new ClaudeCodeRunner({ credential: anthropicCredential });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" }))
      events.push(event);
    expect(events[0]).toMatchObject({ type: "error", captureTruncated: true });
    expect(JSON.stringify(events)).not.toContain("sk-");
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
  it("reads a user tool result without copying provider metadata", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: "file contents",
                metadata: "discard me",
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        type: "tool_result",
        callId: "call-1",
        tool: "unknown",
        output: "file contents",
        status: "success",
      },
    ]);
  });

  it.each(['{"type":"user","private":"fixture-secret"', '[{"private":"fixture-secret"}'])(
    "marks incomplete structured output without retaining its contents: %s",
    (line) => {
      expect(parseStreamJsonLine(line)).toEqual([
        { type: "capture_gap", reason: "unsupported_event" },
      ]);
    },
  );

  it("marks unknown substantive top-level events without copying provider fields", () => {
    expect(
      parseStreamJsonLine(JSON.stringify({ type: "future_output", payload: "fixture-secret" })),
    ).toEqual([{ type: "capture_gap", reason: "unsupported_event" }]);
  });

  it("retains safe text and marks unsupported result content", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                is_error: true,
                content: [
                  { type: "text", text: "before" },
                  { type: "image", source: { data: "opaque-image" } },
                  { type: "text", text: "after" },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "capture_gap", reason: "unsupported_event", callId: "call-1" },
      {
        type: "tool_result",
        callId: "call-1",
        tool: "unknown",
        output: "before\nafter",
        status: "error",
        captureTruncated: true,
      },
    ]);
  });

  it("does not invent text for a result containing only unsupported blocks", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "call-1",
                content: [{ type: "document", source: { data: "opaque-document" } }],
              },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "capture_gap", reason: "unsupported_event", callId: "call-1" },
      {
        type: "tool_result",
        callId: "call-1",
        tool: "unknown",
        output: "",
        status: "success",
        captureTruncated: true,
      },
    ]);
  });

  it("accepts documented empty results and rejects malformed error flags", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "empty-call",
              },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "tool_result", callId: "empty-call", tool: "unknown", output: "", status: "success" },
    ]);
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                is_error: "true",
                content: "discard malformed result",
              },
            ],
          },
        }),
      ),
    ).toEqual([{ type: "capture_gap", reason: "unsupported_event" }]);
  });

  it("marks substantive unsupported assistant blocks in content order", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "before" },
              { type: "thinking", thinking: "sensitive content" },
              { type: "future_block", payload: "sensitive content" },
              { type: "text", text: "after" },
            ],
          },
        }),
      ),
    ).toEqual([
      { type: "progress", text: "before" },
      { type: "capture_gap", reason: "unsupported_event" },
      { type: "capture_gap", reason: "unsupported_event" },
      { type: "progress", text: "after" },
    ]);
  });

  it.each(["system", "message_start", "message_stop", "content_block_stop"])(
    "ignores routine %s framing",
    (type) => {
      expect(parseStreamJsonLine(JSON.stringify({ type }))).toEqual([]);
    },
  );

  it("parses an assistant text block", () => {
    expect(
      parseStreamJsonLine(
        `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`,
      ),
    ).toEqual([{ type: "progress", text: "hi" }]);
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

  it("parses measured usage and provider-reported cost", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "done",
          usage: { input_tokens: 120, output_tokens: 30 },
          total_cost_usd: 0.42,
        }),
      ),
    ).toEqual([
      {
        type: "completion",
        taskComplete: true,
        summary: "done",
        finalOutput: "done",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          provenance: "measured",
          costUsd: 0.42,
          costProvenance: "measured",
        },
      },
    ]);
  });

  it("includes cache reads and cache writes in measured input tokens", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          result: "cached",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 200,
            output_tokens: 30,
          },
          total_cost_usd: 0.42,
        }),
      )[0],
    ).toMatchObject({
      usage: {
        inputTokens: 1_100,
        outputTokens: 30,
        provenance: "measured",
        costUsd: 0.42,
        costProvenance: "measured",
      },
    });
  });

  it.each([
    { cache_read_input_tokens: -1 },
    { cache_creation_input_tokens: 1.5 },
    { cache_read_input_tokens: Number.MAX_SAFE_INTEGER },
  ])("omits usage with invalid cache accounting %j", (cacheUsage) => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 100, output_tokens: 30, ...cacheUsage },
        }),
      )[0],
    ).not.toHaveProperty("usage");
  });

  it("accepts explicitly measured zero usage and cost", () => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 0, output_tokens: 0 },
          total_cost_usd: 0,
        }),
      )[0],
    ).toMatchObject({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        provenance: "measured",
        costUsd: 0,
        costProvenance: "measured",
      },
    });
  });

  it.each([
    { input_tokens: 1 },
    { output_tokens: 1 },
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1, output_tokens: -1 },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1 },
    { input_tokens: Number.NaN, output_tokens: 1 },
    { input_tokens: 1, output_tokens: Number.POSITIVE_INFINITY },
    { input_tokens: "1", output_tokens: 1 },
  ])("omits malformed or partial Claude usage %j", (usage) => {
    expect(
      parseStreamJsonLine(
        JSON.stringify({ type: "result", subtype: "success", usage, total_cost_usd: 0.1 }),
      )[0],
    ).toMatchObject({ type: "completion", taskComplete: true });
    expect(
      parseStreamJsonLine(
        JSON.stringify({ type: "result", subtype: "success", usage, total_cost_usd: 0.1 }),
      )[0],
    ).not.toHaveProperty("usage");
  });

  it.each([-0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.1", null])(
    "omits invalid Claude cost %j while retaining valid usage",
    (totalCostUsd) => {
      const [event] = parseStreamJsonLine(
        JSON.stringify({
          type: "result",
          subtype: "success",
          usage: { input_tokens: 2, output_tokens: 3 },
          total_cost_usd: totalCostUsd,
        }),
      );
      expect(event).toMatchObject({
        usage: { inputTokens: 2, outputTokens: 3, provenance: "measured" },
      });
      expect(event).not.toHaveProperty("usage.costUsd");
      expect(event).not.toHaveProperty("usage.costProvenance");
    },
  );

  it("preserves measured usage on an error result without marking the task complete", () => {
    const events = parseStreamJsonLine(
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "failed after work",
        usage: { input_tokens: 9, output_tokens: 4 },
        total_cost_usd: 0.07,
      }),
    );
    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: false,
        summary: "Claude Code result was unsuccessful",
        usage: {
          inputTokens: 9,
          outputTokens: 4,
          provenance: "measured",
          costUsd: 0.07,
          costProvenance: "measured",
        },
      },
      {
        type: "error",
        message: "Claude Code error_during_execution: failed after work",
      },
    ]);
  });

  it("parses a content_block_delta", () => {
    expect(
      parseStreamJsonLine(`{"type":"content_block_delta","delta":{"text":"partial"}}`),
    ).toEqual([{ type: "progress", text: "partial" }]);
  });

  it("falls back to raw text for non-JSON", () => {
    expect(parseStreamJsonLine("plain output")).toEqual([
      { type: "progress", text: "plain output" },
    ]);
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
      { type: "progress", text: "Inspecting" },
      { type: "tool_use", tool: "Read", input: '{"file":"a.ts"}' },
      { type: "tool_use", tool: "Read", input: '{"file":"b.ts"}' },
      { type: "progress", text: "All done" },
    ]);
  });
});

describe("Claude Code tool capture", () => {
  it("pairs parallel results by call ID and deduplicates partial and authoritative frames", async () => {
    const calls = [
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
      { type: "tool_use", id: "test-1", name: "Bash", input: { command: "pnpm test" } },
    ];
    const results = {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "test-1",
            content: "One assertion failed",
            is_error: true,
          },
          {
            type: "tool_result",
            tool_use_id: "read-1",
            content: [{ type: "text", text: `found ${anthropicCredential.secret}` }],
          },
        ],
      },
    };
    const events = await runClaudeToolRecords([
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Inspecting" },
        },
      },
      {
        type: "assistant",
        message: { id: "message-1", content: [{ type: "text", text: "Inspecting" }] },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "read-1", name: "Read", input: {} },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"README.md"}' },
        },
      },
      { type: "assistant", message: { id: "message-1", content: calls } },
      { type: "stream_event", event: { type: "content_block_stop", index: 1 } },
      { type: "assistant", message: { id: "message-1", content: calls } },
      results,
      results,
      {
        type: "result",
        subtype: "success",
        result: "Fixed the assertion",
        usage: { input_tokens: 12, output_tokens: 5 },
      },
    ]);
    expect(events).toEqual([
      { type: "progress", text: "Inspecting" },
      { type: "tool_use", callId: "read-1", tool: "Read", input: '{"file_path":"README.md"}' },
      { type: "tool_use", callId: "test-1", tool: "Bash", input: '{"command":"pnpm test"}' },
      {
        type: "tool_result",
        callId: "test-1",
        tool: "Bash",
        output: "One assertion failed",
        status: "error",
      },
      {
        type: "tool_result",
        callId: "read-1",
        tool: "Read",
        output: "found [REDACTED]",
        status: "success",
      },
      {
        type: "completion",
        taskComplete: true,
        summary: "Fixed the assertion",
        finalOutput: "Fixed the assertion",
        usage: { inputTokens: 12, outputTokens: 5, provenance: "measured" },
      },
    ]);
  });

  it("marks an orphan result without inventing a tool call", async () => {
    const events = await runClaudeToolRecords([
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "unseen", content: "observed output" }],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);
    expect(events).toEqual([
      { type: "capture_gap", reason: "missing_tool_call" },
      {
        type: "tool_result",
        callId: "unseen",
        tool: "unknown",
        output: "observed output",
        status: "success",
      },
      { type: "completion", taskComplete: true, summary: "done", finalOutput: "done" },
    ]);
  });

  it("reports an unresolved tool before a failed terminal error while retaining usage", async () => {
    const events = await runClaudeToolRecords([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "pending", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      },
      {
        type: "result",
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Turn limit reached"],
        usage: { input_tokens: 8, output_tokens: 2 },
      },
    ]);
    expect(events).toEqual([
      { type: "tool_use", callId: "pending", tool: "Read", input: '{"file_path":"README.md"}' },
      {
        type: "completion",
        taskComplete: false,
        summary: "Claude Code result was unsuccessful",
        usage: { inputTokens: 8, outputTokens: 2, provenance: "measured" },
      },
      { type: "capture_gap", reason: "missing_tool_result", callId: "pending" },
      { type: "error", message: "Claude Code error_max_turns: Turn limit reached" },
    ]);
  });

  it("marks partial tool input without a completed assistant block rather than inventing arguments", async () => {
    const events = await runClaudeToolRecords([
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "partial", name: "Read", input: {} },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"unfinished' },
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);
    expect(events).toEqual([
      { type: "capture_gap", reason: "unsupported_event", callId: "partial" },
      { type: "completion", taskComplete: true, summary: "done", finalOutput: "done" },
    ]);
  });

  it("marks omitted result media before the paired result and retains only text", async () => {
    const events = await runClaudeToolRecords([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "read-image",
              name: "Read",
              input: { file_path: "preview.png" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "read-image",
              content: [
                { type: "image", source: { data: "opaque-image" } },
                { type: "text", text: "image metadata" },
              ],
            },
          ],
        },
      },
      { type: "result", subtype: "success", result: "done" },
    ]);
    expect(events).toEqual([
      {
        type: "tool_use",
        callId: "read-image",
        tool: "Read",
        input: '{"file_path":"preview.png"}',
      },
      { type: "capture_gap", reason: "unsupported_event", callId: "read-image" },
      {
        type: "tool_result",
        callId: "read-image",
        tool: "Read",
        output: "image metadata",
        status: "success",
        captureTruncated: true,
      },
      { type: "completion", taskComplete: true, summary: "done", finalOutput: "done" },
    ]);
    expect(JSON.stringify(events)).not.toContain("opaque-image");
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

  it("streams unsuccessful result usage without treating it as task completion", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        stream: "stdout",
        data: JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["Turn budget exhausted"],
          usage: { input_tokens: 8, output_tokens: 2 },
          total_cost_usd: 0.03,
        }),
      },
    ]);
    const events = [];
    for await (const event of new ClaudeCodeRunner({ credential: anthropicCredential }).start({
      sandbox,
      sessionId: "s",
      prompt: "p",
    }))
      events.push(event);

    expect(events).toEqual([
      {
        type: "completion",
        taskComplete: false,
        summary: "Claude Code result was unsuccessful",
        usage: {
          inputTokens: 8,
          outputTokens: 2,
          provenance: "measured",
          costUsd: 0.03,
          costProvenance: "measured",
        },
      },
      {
        type: "error",
        message: "Claude Code error_max_turns: Turn budget exhausted",
      },
    ]);
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
    expect(events).toEqual([
      { type: "progress", text: "deliverable" },
      expect.objectContaining({ type: "error" }),
    ]);
  });
});
