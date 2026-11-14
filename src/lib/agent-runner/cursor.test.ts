import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "./types";
import { FakeSandbox } from "@/lib/sandbox/fake";
import { harnessPath, runnerCalls } from "./test-helpers";

import { CursorRunner, parseCursorStreamJsonLine } from "./cursor";

const credential = {
  expiresAt: "2026-11-27T00:00:00.000Z",
  generation: "11111111-1111-4111-8111-111111111111",
  secret: "cursor-key",
  userId: "user-1",
};

describe("CursorRunner", () => {
  it("runs cursor-agent in the external sandbox with the user credential", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: '{"type":"assistant","session_id":"cursor-42","message":{"content":[{"type":"text","text":"working"}]}}\n',
        stream: "stdout",
      },
      {
        data: '{"type":"result","session_id":"cursor-42","result":"done"}\n',
        stream: "stdout",
      },
    ]);
    const runner = new CursorRunner({ credential, model: "composer-2" });
    const events = [];
    for await (const event of runner.start({
      continueSessionId: "previous",
      prompt: "Implement this",
      sandbox,
      sessionId: "session-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { text: "working", type: "progress" },
      { summary: "done", finalOutput: "done", taskComplete: true, type: "completion" },
    ]);
    expect(await sandbox.readFile(harnessPath(sandbox, "prompt.txt"))).toBe("Implement this");
    expect(runnerCalls(sandbox)[0]?.args[1]).toContain("'--model' 'composer-2'");
    expect(runnerCalls(sandbox)[0]?.args[1]).toContain("'--resume' 'previous'");
    expect(runnerCalls(sandbox)[0]?.opts.env).toMatchObject({
      CI: "1",
      CURSOR_API_KEY: "cursor-key",
    });
  });

  it.each([
    { progress: [] },
    { progress: ["Inspecting the implementation", "Tests are still running"] },
  ])("separates progress from the complete final deliverable (%j)", async ({ progress }) => {
    const finalOutput = `\n# Delivered\n\n${"Validation passed. ".repeat(1_000)}\n\nBlocker: publication requires credentials.  \n\n`;
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        stream: "stdout",
        data: [
          ...progress.map((text) => ({ type: "assistant", text })),
          { type: "result", subtype: "success", result: finalOutput },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      },
    ]);
    const events = [];
    for await (const event of new CursorRunner({ credential }).start({
      sandbox,
      sessionId: "final-output",
      prompt: "p",
    }))
      events.push(event);
    expect(events).toEqual([
      ...progress.map((text) => ({ type: "progress", text })),
      { type: "completion", taskComplete: true, summary: finalOutput, finalOutput },
    ]);
  });

  it.each([
    {
      result: { type: "result", subtype: "error", is_error: true, result: "Provider stopped" },
      exitCode: 0,
    },
    { result: { type: "result", subtype: "success", result: "Delivered" }, exitCode: 7 },
    { result: undefined, exitCode: 0 },
  ])(
    "does not report successful completion after missing/error results (%j)",
    async ({ result, exitCode }) => {
      const sandbox = new FakeSandbox();
      sandbox.scriptExec(
        "bash",
        [
          {
            stream: "stdout",
            data: [
              { type: "assistant", text: "Tests are still running" },
              ...(result ? [result] : []),
            ]
              .map((record) => JSON.stringify(record))
              .join("\n"),
          },
        ],
        { exitCode },
      );
      const events = [];
      for await (const event of new CursorRunner({ credential }).start({
        sandbox,
        sessionId: "failed-final",
        prompt: "p",
      }))
        events.push(event);
      expect(events[0]).toEqual({ type: "progress", text: "Tests are still running" });
      expect(events.some((event) => event.type === "completion" && event.taskComplete)).toBe(false);
      expect(events.at(-1)).toMatchObject({ type: "error" });
      if (result?.result === "Delivered") {
        expect(events).toContainEqual({ type: "progress", text: "Delivered" });
      }
    },
  );

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
          },
          { type: "result", subtype: "error", result: "Provider failed after response" },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n"),
      },
    ]);
    const events = [];
    for await (const event of new CursorRunner({ credential }).start({
      sandbox,
      sessionId: "late-error",
      prompt: "p",
    }))
      events.push(event);
    expect(events).toEqual([
      { type: "progress", text: "Validation passed. Blocker: release pending." },
      { type: "error", message: "Provider failed after response" },
    ]);
  });

  it.each([{}, { credential: { ...credential, secret: "" } }])(
    "rejects missing eager and lazy credentials (%j)",
    (options) => {
      expect(() => new CursorRunner(options)).toThrow(/Cursor API key/);
    },
  );

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
      return { ...credential, secret: "fresh-cursor-key" };
    });
    const readOriginalSecret = vi.fn(() => "stale-cursor-key");
    const runner = new CursorRunner({
      credential: {
        ...credential,
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

  it("injects and redacts the latest key and reports its generation on auth failure", async () => {
    const sandbox = new FakeSandbox();
    const currentCredential = {
      ...credential,
      generation: "22222222-2222-4222-8222-222222222222",
      secret: "fresh-cursor-key",
    };
    sandbox.scriptExec(
      "bash",
      [{ data: "401 invalid api key fresh-cursor-key", stream: "stderr" }],
      { exitCode: 1 },
    );
    const loadCredential = vi.fn(async () => {
      expect(sandbox.files.has(harnessPath(sandbox, "prompt.txt"))).toBe(true);
      expect(runnerCalls(sandbox)).toHaveLength(0);
      return currentCredential;
    });
    const onAuthenticationFailure = vi.fn();
    const runner = new CursorRunner({ credential, loadCredential, onAuthenticationFailure });
    const events = [];

    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(loadCredential).toHaveBeenCalledOnce();
    expect(runnerCalls(sandbox)).toHaveLength(1);
    expect(runnerCalls(sandbox)[0]?.opts.env).toMatchObject({ CURSOR_API_KEY: "fresh-cursor-key" });
    expect(runnerCalls(sandbox)[0]?.opts.env?.CURSOR_API_KEY).not.toBe(credential.secret);
    expect(onAuthenticationFailure).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("401 invalid api key [REDACTED]"),
      currentCredential,
    );
    expect(JSON.stringify(events)).not.toContain(currentCredential.secret);
  });

  it("rechecks lazy credentials on each start", async () => {
    const sandbox = new FakeSandbox();
    const loadCredential = vi
      .fn()
      .mockResolvedValueOnce(credential)
      .mockRejectedValueOnce(new Error("Session creator is no longer active"));
    const runner = new CursorRunner({ loadCredential });
    const consume = async () => {
      for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
        void event;
      }
    };

    await consume();
    await expect(consume()).rejects.toThrow(/no longer active/);

    expect(loadCredential).toHaveBeenCalledTimes(2);
    expect(runnerCalls(sandbox)).toHaveLength(1);
  });

  it("marks the connection for reconnect after an authentication failure", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [{ data: "401 invalid api key", stream: "stderr" }], {
      exitCode: 1,
    });
    const onAuthenticationFailure = vi.fn();
    const runner = new CursorRunner({ credential, onAuthenticationFailure });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }
    expect(onAuthenticationFailure).toHaveBeenCalledOnce();
    expect(events).toEqual([
      expect.objectContaining({ message: expect.stringContaining("401"), type: "error" }),
    ]);
  });

  it("redacts the Cursor API key from CLI error output", async () => {
    const secret = "sk-cursor-live-secret-value-12345";
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [{ data: `401 invalid api key ${secret}`, stream: "stderr" }], {
      exitCode: 1,
    });
    const onAuthenticationFailure = vi.fn();
    const runner = new CursorRunner({
      credential: { ...credential, secret },
      onAuthenticationFailure,
    });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(onAuthenticationFailure).toHaveBeenCalledOnce();
    expect(onAuthenticationFailure.mock.calls[0]?.[0]).not.toContain(secret);
    expect(events).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/401 invalid api key \[REDACTED\]/),
        type: "error",
      }),
    ]);
    expect(events[0]).toMatchObject({ type: "error" });
    if (events[0]?.type === "error") {
      expect(events[0].message).not.toContain(secret);
    }
  });

  it.each([500, 501])(
    "marks stderr clipped beyond the 500-character boundary (%i)",
    async (length) => {
      const sandbox = new FakeSandbox();
      sandbox.scriptExec("bash", [{ data: "x".repeat(length), stream: "stderr" }], { exitCode: 1 });
      const runner = new CursorRunner({ credential });
      const events = [];
      for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" }))
        events.push(event);
      expect(events).toEqual([
        {
          type: "error",
          message: `Cursor CLI exited with code 1: ${"x".repeat(500)}`,
          ...(length > 500 ? { captureTruncated: true } : {}),
        },
      ]);
    },
  );

  it("redacts unknown credentials before clipping stderr", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [{ data: `${"x".repeat(490)} sk-${"a".repeat(60)} ${"y".repeat(100)}`, stream: "stderr" }],
      { exitCode: 1 },
    );
    const runner = new CursorRunner({ credential });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" }))
      events.push(event);
    expect(events[0]).toMatchObject({ type: "error", captureTruncated: true });
    expect(JSON.stringify(events)).not.toContain("sk-");
  });

  it("redacts the Cursor API key from completed tool stdout before yielding", async () => {
    const secret = "sk-cursor-live-secret-value-12345";
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `${JSON.stringify({
          subtype: "completed",
          tool_call: {
            shellToolCall: {
              args: { command: "printenv CURSOR_API_KEY" },
              result: { success: { exitCode: 0, stderr: "", stdout: secret } },
            },
          },
          type: "tool_call",
        })}\n`,
        stream: "stdout",
      },
      {
        data: '{"type":"result","result":"done"}\n',
        stream: "stdout",
      },
    ]);
    const runner = new CursorRunner({ credential: { ...credential, secret } });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    const toolUse = events.find((event) => event.type === "tool_result");
    expect(toolUse).toMatchObject({ tool: "shell", type: "tool_result" });
    if (!toolUse || toolUse.type !== "tool_result") {
      throw new Error("expected tool_use event");
    }
    expect(toolUse.output).not.toContain(secret);
    expect(toolUse.output).toContain("[REDACTED]");
    expect(JSON.parse(toolUse.output)).toMatchObject({
      exitCode: 0,
      stdout: "[REDACTED]",
    });
  });

  it("redacts the sandbox GitHub token from completed tool stdout before yielding", async () => {
    const installationToken = "ghs_sandbox-installation-token-12345";
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `${JSON.stringify({
          subtype: "completed",
          tool_call: {
            shellToolCall: {
              args: { command: "printenv GH_TOKEN" },
              result: { success: { exitCode: 0, stderr: "", stdout: installationToken } },
            },
          },
          type: "tool_call",
        })}\n`,
        stream: "stdout",
      },
      {
        data: '{"type":"result","result":"done"}\n',
        stream: "stdout",
      },
    ]);
    const runner = new CursorRunner({ credential });
    const events = [];
    for await (const event of runner.start({
      prompt: "p",
      sandbox,
      secrets: [installationToken],
      sessionId: "s",
    })) {
      events.push(event);
    }

    const toolUse = events.find((event) => event.type === "tool_result");
    expect(toolUse).toMatchObject({ tool: "shell", type: "tool_result" });
    if (!toolUse || toolUse.type !== "tool_result") {
      throw new Error("expected tool_use event");
    }
    expect(toolUse.output).not.toContain(installationToken);
    expect(toolUse.output).toContain("[REDACTED]");
    expect(JSON.parse(toolUse.output)).toMatchObject({
      exitCode: 0,
      stdout: "[REDACTED]",
    });
  });

  it("redacts the sandbox GitHub token from CLI error output", async () => {
    const installationToken = "ghs_sandbox-installation-token-12345";
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [{ data: `fatal: ${installationToken}`, stream: "stderr" }], {
      exitCode: 1,
    });
    const runner = new CursorRunner({ credential });
    const events = [];
    for await (const event of runner.start({
      prompt: "p",
      sandbox,
      secrets: [installationToken],
      sessionId: "s",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      expect.objectContaining({
        message: expect.stringMatching(/fatal: \[REDACTED\]/),
        type: "error",
      }),
    ]);
    if (events[0]?.type === "error") {
      expect(events[0].message).not.toContain(installationToken);
    }
  });
});

function parseToolUse(line: string, secrets: Array<string | undefined> = []) {
  const event = parseCursorStreamJsonLine(line, secrets).events[0];
  expect(event).toMatchObject({ type: "tool_use" });
  if (!event || event.type !== "tool_use") {
    throw new Error("expected tool_use event");
  }
  return { event, input: JSON.parse(event.input) as Record<string, unknown> };
}

function parseToolResult(line: string, secrets: Array<string | undefined> = []) {
  const event = parseCursorStreamJsonLine(line, secrets).events.find(
    (event) => event.type === "tool_result",
  );
  if (!event || event.type !== "tool_result") throw new Error("expected tool_result event");
  return { event, output: JSON.parse(event.output) as Record<string, unknown> };
}

describe("parseCursorStreamJsonLine", () => {
  it("parses assistant, tool, and result records", () => {
    expect(
      parseCursorStreamJsonLine(
        '{"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":"hello"}]}}',
      ),
    ).toEqual({ events: [{ text: "hello", type: "progress" }], sessionId: "s" });
    expect(
      parseCursorStreamJsonLine(
        '{"type":"tool_call","subtype":"started","tool_call":{"name":"shell","args":{"cmd":"ls"}}}',
      ).events[0],
    ).toEqual({ input: '{"cmd":"ls"}', tool: "shell", type: "tool_use" });
    expect(parseCursorStreamJsonLine('{"type":"result","result":"done"}').events[0]).toEqual({
      summary: "done",
      finalOutput: "done",
      taskComplete: true,
      type: "completion",
    });
  });

  it("leaves usage unavailable even if a result contains telemetry-shaped fields", () => {
    const {
      events: [event],
    } = parseCursorStreamJsonLine(
      JSON.stringify({
        type: "result",
        result: "done",
        usage: { input_tokens: 10, output_tokens: 5 },
        total_cost_usd: 0.25,
      }),
    );
    expect(event).toEqual({
      summary: "done",
      finalOutput: "done",
      taskComplete: true,
      type: "completion",
    });
    expect(event).not.toHaveProperty("usage");
  });

  it("redacts explicit final output and never promotes fallback bookkeeping", () => {
    expect(
      parseCursorStreamJsonLine(JSON.stringify({ type: "result", result: "Final secret-token" }), [
        "secret-token",
      ]).events[0],
    ).toMatchObject({ finalOutput: "Final [REDACTED]" });
    expect(
      parseCursorStreamJsonLine(JSON.stringify({ type: "result" })).events[0],
    ).not.toHaveProperty("finalOutput");
  });

  it("extracts nested *ToolCall names and args from official stream-json", () => {
    expect(
      parseCursorStreamJsonLine(
        JSON.stringify({
          call_id: "toolu_read",
          subtype: "started",
          tool_call: { readToolCall: { args: { path: "file.txt" } } },
          type: "tool_call",
        }),
      ).events[0],
    ).toEqual({
      input: '{"path":"file.txt"}',
      tool: "read",
      type: "tool_use",
      callId: "toolu_read",
    });

    const glob = parseToolUse(
      JSON.stringify({
        subtype: "started",
        tool_call: {
          globToolCall: { args: { globPattern: "**/*.ts", targetDirectory: "src" } },
        },
        type: "tool_call",
      }),
    );
    expect(glob.event.tool).toBe("glob");
    expect(glob.input).toEqual({
      globPattern: "**/*.ts",
      targetDirectory: "src",
    });
  });

  it("retains bounded completed tool output separately from its input", () => {
    const stdout = "x".repeat(4000);
    const completed = parseToolResult(
      JSON.stringify({
        call_id: "toolu_shell",
        subtype: "completed",
        tool_call: {
          shellToolCall: {
            args: { command: "cat huge.log" },
            result: { success: { exitCode: 0, stderr: "", stdout } },
          },
        },
        type: "tool_call",
      }),
    );

    expect(completed.event.tool).toBe("shell");
    expect(completed.event.captureTruncated).toBe(true);
    expect(completed.output).toMatchObject({
      exitCode: 0,
      stderr: "",
    });
    expect(completed.output.stdout).toBe(`${"x".repeat(500)}…`);
    expect(completed.event.output).not.toContain(stdout);

    const readCompleted = parseToolResult(
      JSON.stringify({
        subtype: "completed",
        tool_call: {
          readToolCall: {
            args: { path: "README.md" },
            result: {
              success: {
                content: "# Project\n\nThis is a sample project...",
                exceededLimit: false,
                isEmpty: false,
                totalChars: 1254,
                totalLines: 54,
              },
            },
          },
        },
        type: "tool_call",
      }),
    );
    expect(readCompleted.event.tool).toBe("read");
    expect(readCompleted.event.captureTruncated).toBeUndefined();
    expect(readCompleted.output).toEqual({
      content: "# Project\n\nThis is a sample project...",
      exceededLimit: false,
      isEmpty: false,
      totalChars: 1254,
      totalLines: 54,
    });
  });

  it("redacts known secrets from tool results before truncation", () => {
    const secret = "sk-cursor-live-secret-value-12345";
    const completed = parseToolResult(
      JSON.stringify({
        subtype: "completed",
        tool_call: {
          shellToolCall: {
            args: { command: "printenv CURSOR_API_KEY" },
            result: {
              success: {
                exitCode: 0,
                stderr: "",
                stdout: `${secret}\n${"x".repeat(4000)}`,
              },
            },
          },
        },
        type: "tool_call",
      }),
      [secret],
    );

    expect(completed.event.tool).toBe("shell");
    expect(completed.event.output).not.toContain(secret);
    expect(completed.output.stdout).toBe(`[REDACTED]\n${"x".repeat(489)}…`);
  });

  it("redacts a sandbox GitHub token from tool results before truncation", () => {
    const installationToken = "ghs_sandbox-installation-token-12345";
    const completed = parseToolResult(
      JSON.stringify({
        subtype: "completed",
        tool_call: {
          shellToolCall: {
            args: { command: "printenv GH_TOKEN" },
            result: {
              success: {
                exitCode: 0,
                stderr: "",
                stdout: `${installationToken}\n${"x".repeat(4000)}`,
              },
            },
          },
        },
        type: "tool_call",
      }),
      [installationToken],
    );

    expect(completed.event.tool).toBe("shell");
    expect(completed.event.output).not.toContain(installationToken);
    expect(completed.output.stdout).toBe(`[REDACTED]\n${"x".repeat(489)}…`);
  });

  it.each([
    {
      name: "intact strings and arrays",
      args: { note: "x".repeat(500), files: Array(20).fill("x") },
      truncated: false,
    },
    { name: "long strings", args: { note: "x".repeat(501) }, truncated: true },
    { name: "long arrays", args: { files: Array(21).fill("x") }, truncated: true },
    ...[
      "afterFullFileContent",
      "content",
      "diffString",
      "directoryTreeRoot",
      "fileText",
      "parsingResult",
    ].map((field) => ({
      name: `omitted ${field}`,
      args: { [field]: "omitted", path: "a.ts" },
      truncated: true,
    })),
    {
      name: "total payload limit",
      args: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`field${index}`, "x".repeat(450)]),
      ),
      truncated: true,
    },
  ])("marks actual capture loss for $name", ({ args, truncated }) => {
    const {
      events: [event],
    } = parseCursorStreamJsonLine(JSON.stringify({ type: "tool_call", input: args }));
    expect(event?.type).toBe("tool_use");
    if (event?.type !== "tool_use") throw new Error("Expected tool event");
    expect(event.captureTruncated).toBe(truncated ? true : undefined);
    expect(event.input.length).toBeLessThanOrEqual(4096);
  });

  it("redacts unknown credential patterns before clipping tool output", () => {
    const secret = `sk-${"a".repeat(60)}`;
    const completed = parseToolResult(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          shellToolCall: {
            args: {},
            result: { success: { stdout: `${"x".repeat(490)} ${secret} ${"y".repeat(100)}` } },
          },
        },
      }),
    );
    expect(completed.event.captureTruncated).toBe(true);
    expect(completed.event.output).not.toContain("sk-");
  });

  it.each([
    '{"type":"tool_call","input":{"api_key":"raw-secret"',
    '[{"api_key":"raw-secret"}',
    '["raw-secret"',
    "null",
    "42",
    "true",
    '"raw-secret"',
    "[]",
  ])("marks malformed or nonobject JSON without echoing it (%s)", (line) => {
    expect(parseCursorStreamJsonLine(line)).toEqual({
      events: [{ type: "capture_gap", reason: "unsupported_event" }],
    });
  });

  it.each(["ordinary CLI progress", "[info] plain progress", "[warning] still working"])(
    "retains ordinary text progress (%s)",
    (line) => {
      expect(parseCursorStreamJsonLine(line)).toEqual({
        events: [{ type: "progress", text: line }],
      });
    },
  );

  it("never uses subtype as the tool name", () => {
    expect(
      parseCursorStreamJsonLine('{"type":"tool_call","subtype":"started","tool_call":{}}')
        .events[0],
    ).toEqual({ type: "capture_gap", reason: "unsupported_event" });
    expect(
      parseCursorStreamJsonLine('{"type":"tool_call","subtype":"completed"}').events[0],
    ).toEqual({
      type: "capture_gap",
      reason: "missing_tool_result",
    });
  });
});

// Native envelope fixtures: https://cursor.com/docs/cli/reference/output-format#tool-call-events
// Headless rejections: https://cursor.com/docs/cli/headless#file-modification-in-scripts
describe("Cursor native tool outcomes", () => {
  const read = {
    type: "tool_call",
    subtype: "started",
    call_id: "read-1",
    tool_call: { readToolCall: { args: { path: "README.md" } } },
  };
  const write = {
    type: "tool_call",
    subtype: "started",
    call_id: "write-1",
    tool_call: {
      writeToolCall: { args: { path: "summary.txt", toolCallId: "write-1", fileText: "summary" } },
    },
  };
  const done = { type: "result", subtype: "success", result: "Final deliverable" };
  async function collect(records: unknown[], exitCode = 0) {
    const stream = records.map((record) => JSON.stringify(record)).join("\n");
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [
        { stream: "stdout", data: stream.slice(0, 23) },
        { stream: "stdout", data: stream.slice(23) },
      ],
      { exitCode },
    );
    const events: AgentEvent[] = [];
    for await (const event of new CursorRunner({ credential }).start({
      sandbox,
      prompt: "p",
      sessionId: "s",
    }))
      events.push(event);
    return events;
  }

  it("keeps interleaved outcomes in order and avoids repeated call or result rows", async () => {
    const readDone = {
      ...read,
      subtype: "completed",
      tool_call: {
        readToolCall: {
          args: { path: "README.md" },
          result: { success: { content: "read content", totalLines: 1, totalChars: 12 } },
        },
      },
    };
    const writeDone = {
      ...write,
      subtype: "completed",
      tool_call: {
        writeToolCall: {
          args: { path: "summary.txt", toolCallId: "write-1", fileText: "summary" },
          result: { success: { path: "summary.txt", linesCreated: 1, fileSize: 7 } },
        },
      },
    };
    const events = await collect([
      read,
      write,
      read,
      { type: "assistant", text: "Working" },
      writeDone,
      readDone,
      writeDone,
      done,
    ]);
    expect(events).toEqual([
      { type: "tool_use", tool: "read", input: '{"path":"README.md"}', callId: "read-1" },
      {
        type: "tool_use",
        tool: "write",
        input: '{"path":"summary.txt"}',
        callId: "write-1",
        captureTruncated: true,
      },
      { type: "progress", text: "Working" },
      {
        type: "tool_result",
        tool: "write",
        output: '{"path":"summary.txt","linesCreated":1,"fileSize":7}',
        status: "success",
        callId: "write-1",
      },
      {
        type: "tool_result",
        tool: "read",
        output: '{"content":"read content","totalLines":1,"totalChars":12}',
        status: "success",
        callId: "read-1",
      },
      {
        type: "completion",
        taskComplete: true,
        summary: "Final deliverable",
        finalOutput: "Final deliverable",
      },
    ]);
    expect(
      events
        .filter((event) => event.type === "tool_use")
        .map((event) => event.input)
        .join(""),
    ).not.toContain("toolCallId");
  });

  it.each([
    {
      result: { success: { stdout: "", stderr: "", exitCode: 0 } },
      status: "success",
      exitCode: 0,
    },
    {
      result: { success: { stdout: "", stderr: "test failed", exitCode: 2 } },
      status: "error",
      exitCode: 2,
    },
    { result: { error: { message: "file missing" } }, status: "error" },
    { result: { rejected: { reason: "permission denied" } }, status: "error", outcome: "rejected" },
  ])(
    "retains explicit outcomes without converting completed into success (%j)",
    async ({ result, status, exitCode, outcome }) => {
      const events = await collect([
        {
          type: "tool_call",
          subtype: "completed",
          call_id: "shell-1",
          tool_call: { shellToolCall: { args: { command: "check" }, result } },
        },
        done,
      ]);
      expect(events[0]).toEqual({
        type: "tool_use",
        tool: "shell",
        input: '{"command":"check"}',
        callId: "shell-1",
      });
      expect(events[1]).toMatchObject({
        type: "tool_result",
        status,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(outcome ? { outcome } : {}),
      });
      expect(events.at(-1)).toMatchObject({ type: "completion", finalOutput: "Final deliverable" });
      expect(events.some((event) => event.type === "error")).toBe(false);
    },
  );

  it.each([
    undefined,
    null,
    {},
    { success: null },
    { success: {} },
    { success: [] },
    { success: true },
    { success: { stdout: "x" }, error: { message: "contradiction" } },
    { futureOutcome: { raw: "hidden-value" } },
  ])("labels missing or unknown outcomes rather than fabricating a result (%j)", async (result) => {
    const events = await collect([
      read,
      {
        ...read,
        subtype: "completed",
        tool_call: { readToolCall: { args: { path: "README.md" }, result } },
      },
      done,
    ]);
    expect(events.some((event) => event.type === "tool_result")).toBe(false);
    expect(events).toContainEqual({
      type: "capture_gap",
      reason: "missing_tool_result",
      callId: "read-1",
    });
    expect(JSON.stringify(events)).not.toContain("hidden-value");
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(1);
  });

  it("keeps an orphan result without inventing call arguments", async () => {
    const events = await collect([
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "orphan",
        tool_call: { readToolCall: { result: { success: { content: "observed" } } } },
      },
      done,
    ]);
    expect(events.slice(0, -1)).toEqual([
      { type: "capture_gap", reason: "missing_tool_call" },
      {
        type: "tool_result",
        tool: "read",
        output: '{"content":"observed"}',
        status: "success",
        callId: "orphan",
      },
    ]);
  });

  it("does not emit a duplicate call on an uncorrelated completion", async () => {
    const events = await collect([
      {
        type: "tool_call",
        subtype: "started",
        tool_call: { readToolCall: { args: { path: "README.md" } } },
      },
      {
        type: "tool_call",
        subtype: "completed",
        tool_call: {
          readToolCall: {
            args: { path: "README.md" },
            result: { success: { content: "observed" } },
          },
        },
      },
      done,
    ]);
    expect(events.filter((event) => event.type === "tool_use")).toHaveLength(1);
    expect(events).toContainEqual({ type: "capture_gap", reason: "missing_tool_call" });
  });

  it("supports documented generic function arguments and explicit result wrappers", async () => {
    const events = await collect([
      {
        type: "tool_call",
        subtype: "completed",
        call_id: "fn-1",
        tool_call: {
          function: {
            name: "search",
            arguments: '{"query":"docs"}',
            result: { success: { matches: ["one"] } },
          },
        },
      },
      done,
    ]);
    expect(events.slice(0, -1)).toEqual([
      { type: "tool_use", tool: "search", input: '{"query":"docs"}', callId: "fn-1" },
      {
        type: "tool_result",
        tool: "search",
        output: '{"matches":["one"]}',
        status: "success",
        callId: "fn-1",
      },
    ]);
  });

  it("labels provider-limited output and clips retained read content after redaction", async () => {
    const events = await collect([
      {
        ...read,
        subtype: "completed",
        tool_call: {
          readToolCall: {
            args: { path: "README.md" },
            result: {
              success: {
                content: 'echo {"api_key":"unknown-secret"} ' + "x".repeat(900),
                exceededLimit: true,
              },
            },
          },
        },
      },
      done,
    ]);
    const result = events.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({ type: "tool_result", captureTruncated: true });
    expect(JSON.stringify(result)).not.toContain("unknown-secret");
    if (result?.type !== "tool_result") throw new Error("Missing result");
    expect(JSON.parse(result.output).content.length).toBe(501);
  });

  it("omits opaque result metadata and attachments while retaining bounded text", async () => {
    const events = await collect([
      {
        ...read,
        subtype: "completed",
        tool_call: {
          readToolCall: {
            args: { path: "README.md" },
            result: {
              success: {
                content: "visible",
                toolCallId: "hidden-call",
                _meta: { token: "hidden-meta" },
                attachments: [{ type: "image", data: "hidden-base64" }],
              },
            },
          },
        },
      },
      done,
    ]);
    expect(events).toContainEqual({
      type: "capture_gap",
      reason: "unsupported_event",
      callId: "read-1",
    });
    expect(events).toContainEqual({
      type: "tool_result",
      tool: "read",
      output: '{"content":"visible"}',
      status: "success",
      captureTruncated: true,
      callId: "read-1",
    });
    expect(JSON.stringify(events)).not.toContain("hidden-");
  });

  it("does not turn metadata-only or binary-only payloads into empty success", async () => {
    for (const success of [{ metadata: { raw: "hidden" } }, { type: "image", data: "hidden" }]) {
      const events = await collect([
        {
          ...read,
          subtype: "completed",
          tool_call: { readToolCall: { args: { path: "README.md" }, result: { success } } },
        },
        done,
      ]);
      expect(events.some((event) => event.type === "tool_result")).toBe(false);
      expect(events).toContainEqual({
        type: "capture_gap",
        reason: "unsupported_event",
        callId: "read-1",
      });
      expect(JSON.stringify(events)).not.toContain("hidden");
    }
  });

  it("marks cancellation and disconnect records without manufacturing tool results", async () => {
    const events = await collect(
      [
        read,
        { type: "connection", subtype: "reconnecting", raw: "hidden-connection" },
        { type: "tool_call", subtype: "cancelled", call_id: "read-1", raw: "hidden-cancellation" },
        { type: "result", subtype: "cancelled", is_error: true, result: "Canceled" },
      ],
      1,
    );
    expect(
      events.some((event) => event.type === "tool_result" || event.type === "completion"),
    ).toBe(false);
    expect(events).toContainEqual({
      type: "capture_gap",
      reason: "missing_tool_result",
      callId: "read-1",
    });
    expect(JSON.stringify(events)).not.toContain("hidden-");
  });

  it("rejects an aborted live iterator without turning pending work into success", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      { stream: "stdout", data: JSON.stringify(read) + "\n" },
      { stream: "stdout", data: JSON.stringify(done) + "\n" },
    ]);
    const controller = new AbortController();
    const run = new CursorRunner({ credential })
      .start({ sandbox, prompt: "p", sessionId: "s", signal: controller.signal })
      [Symbol.asyncIterator]();
    expect((await run.next()).value).toMatchObject({ type: "tool_use", callId: "read-1" });
    controller.abort(new Error("Canceled by test"));
    await expect(run.next()).rejects.toThrow("Canceled by test");
  });

  it("surfaces transport disconnection after the observed call without fabricated output", async () => {
    const sandbox = new FakeSandbox();
    const original = sandbox.exec.bind(sandbox);
    vi.spyOn(sandbox, "exec").mockImplementation(async (...args) => {
      const proc = await original(...args);
      if (args[0] !== "bash") return proc;
      return {
        ...proc,
        logs: async function* () {
          yield { stream: "stdout" as const, data: JSON.stringify(read) + "\n" };
          throw new Error("transport disconnected");
        },
      };
    });
    const run = new CursorRunner({ credential })
      .start({ sandbox, prompt: "p", sessionId: "s" })
      [Symbol.asyncIterator]();
    expect((await run.next()).value).toMatchObject({ type: "tool_use", callId: "read-1" });
    await expect(run.next()).rejects.toThrow("transport disconnected");
  });
});
