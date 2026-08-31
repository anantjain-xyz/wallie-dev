import { describe, expect, it } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { OpenCodeRunner, parseOpenCodeLine } from "./opencode";

const credential = { secret: "zen-secret-key-1234567890" };

describe("OpenCodeRunner", () => {
  it("requires a Zen API key and a sandbox", async () => {
    expect(() => new OpenCodeRunner({ credential: { secret: "" } })).toThrow(
      /OpenCode Zen API key/,
    );

    const runner = new OpenCodeRunner({ credential });
    expect(runner.provider).toBe("opencode");
    expect(runner.requiresSandbox).toBe(true);
    await expect(
      (async () => {
        for await (const event of runner.start({ prompt: "p", sessionId: "s" })) {
          void event;
        }
      })(),
    ).rejects.toThrow(/requires a sandbox/);
  });

  it("uses isolated auth, parses partial NDJSON, totals usage, and captures continuation", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `{"type":"text","sessionID":"native-42","part":{"text":"work`,
        stream: "stdout",
      },
      { data: `ing"}}\n{"type":"tool_use","sessionID":"native-42",`, stream: "stdout" },
      {
        data:
          `"part":{"tool":"bash","state":{"status":"completed",` +
          `"input":{"command":"ls"}}}}\n` +
          `{"type":"step_finish","sessionID":"native-42","part":{"tokens":{"input":10,"output":4}}}\n` +
          `{"type":"step_finish","sessionID":"native-42","part":{"tokens":{"input":7,"output":3}}}`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({
      credential,
      model: "opencode/gpt-5.6-sol",
    });
    const events = [];
    for await (const event of runner.start({
      continueSessionId: "native-previous",
      prompt: "Implement it",
      runId: "run/1",
      sandbox,
      sessionId: "session-1",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text", text: "working" },
      { type: "tool_use", tool: "bash", input: `{"command":"ls"}` },
      {
        type: "completion",
        taskComplete: true,
        summary: "OpenCode session: native-42",
        usage: { inputTokens: 17, outputTokens: 7 },
      },
    ]);

    const authPath = "/tmp/wallie-opencode-run-1/data/opencode/auth.json";
    const promptPath = "/tmp/wallie-opencode-run-1/prompt.txt";
    expect(await sandbox.readFile(authPath)).toBe(
      `${JSON.stringify({ opencode: { type: "api", key: credential.secret } })}\n`,
    );
    expect(sandbox.files.get(authPath)?.mode).toBe(0o600);
    expect(await sandbox.readFile(promptPath)).toBe("Implement it");
    expect(sandbox.files.get(promptPath)?.mode).toBe(0o600);

    const [call] = sandbox.calls;
    expect(call.cmd).toBe("bash");
    expect(call.args[1]).toContain(
      "opencode 'run' '--format' 'json' '--model' 'opencode/gpt-5.6-sol'",
    );
    expect(call.args[1]).not.toContain("'--auto'");
    expect(call.args[1]).toContain("'--session' 'native-previous'");
    expect(call.args[1]).toContain(`< '${promptPath}'`);
    expect(call.args.join(" ")).not.toContain(credential.secret);
    expect(call.opts.env).toMatchObject({
      CI: "1",
      XDG_DATA_HOME: "/tmp/wallie-opencode-run-1/data",
    });
    expect(JSON.stringify(call.opts)).not.toContain(credential.secret);
  });

  it("emits completed and failed tool events but ignores pending tool events", () => {
    expect(
      parseOpenCodeLine(
        `{"type":"tool_use","part":{"tool":"read","state":{"status":"pending","input":{}}}}`,
      ),
    ).toEqual({ events: [], sessionId: undefined });
    expect(
      parseOpenCodeLine(
        `{"type":"tool_use","part":{"tool":"read","state":{"status":"error","input":{"path":"x"}}}}`,
      ),
    ).toEqual({
      events: [{ type: "tool_use", tool: "read", input: `{"path":"x"}` }],
      sessionId: undefined,
    });
  });

  it("compacts bulky tool input before emitting it", () => {
    const secret = "tool-input-secret";
    const parsed = parseOpenCodeLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "write",
          state: {
            status: "completed",
            input: {
              content: `${secret}${"x".repeat(20_000)}`,
              note: `${secret}${"y".repeat(20_000)}`,
              path: "src/large.ts",
            },
          },
        },
      }),
      [secret],
    );

    expect(parsed?.events).toEqual([
      {
        type: "tool_use",
        tool: "write",
        input: JSON.stringify({
          note: `[REDACTED]${"y".repeat(490)}…`,
          path: "src/large.ts",
        }),
      },
    ]);
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(JSON.stringify(parsed)).not.toContain("x".repeat(100));

    const bounded = parseOpenCodeLine(
      JSON.stringify({
        type: "tool_use",
        part: {
          tool: "custom",
          state: {
            status: "completed",
            input: Object.fromEntries(
              Array.from({ length: 20 }, (_, index) => [`field${index}`, "z".repeat(2_000)]),
            ),
          },
        },
      }),
    );
    const boundedInput = (bounded?.events[0] as { input: string }).input;
    expect(boundedInput.length).toBeLessThanOrEqual(4_096);
    expect(boundedInput.endsWith("…[truncated]")).toBe(true);
  });

  it("emits a useful clipped non-zero error without exposing the credential", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [{ data: `${"x".repeat(600)} ${credential.secret}`, stream: "stderr" }],
      { exitCode: 9 },
    );

    const runner = new OpenCodeRunner({ credential });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    const message = (events[0] as { message: string }).message;
    expect(message).toContain("exited with code 9");
    expect(message).not.toContain(credential.secret);
    expect(message.length).toBeLessThan(550);
  });

  it("surfaces JSON error events and redacts the credential", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `${JSON.stringify({ type: "error", error: { message: `bad ${credential.secret}` } })}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({ credential });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "error", message: "bad [REDACTED]" }]);
  });

  it("redacts credentials echoed in text and tool input events", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data:
          `{"type":"text","part":{"text":"${credential.secret}"}}\n` +
          `{"type":"tool_use","part":{"tool":"echo","state":{"status":"completed","input":{"key":"${credential.secret}"}}}}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({ credential });
    const events = [];
    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "[REDACTED]" });
    expect(events).toContainEqual({
      type: "tool_use",
      tool: "echo",
      input: '{"key":"[REDACTED]"}',
    });
    expect(JSON.stringify(events)).not.toContain(credential.secret);
  });

  it("redacts caller-supplied secrets from streamed output", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [
      {
        data: `{"type":"text","part":{"text":"github-secret"}}\n`,
        stream: "stdout",
      },
    ]);

    const runner = new OpenCodeRunner({ credential });
    const events = [];
    for await (const event of runner.start({
      prompt: "p",
      sandbox,
      secrets: ["github-secret"],
      sessionId: "s",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "text", text: "[REDACTED]" });
  });
});

describe("parseOpenCodeLine", () => {
  it("ignores malformed lines", () => {
    expect(parseOpenCodeLine("not json")).toBeNull();
    expect(parseOpenCodeLine("   ")).toBeNull();
  });

  it("parses nested error messages", () => {
    expect(
      parseOpenCodeLine(
        `{"type":"error","sessionID":"s1","error":{"data":{"message":"provider unavailable"}}}`,
      ),
    ).toEqual({
      events: [{ type: "error", message: "provider unavailable" }],
      sessionId: "s1",
    });
  });

  it("captures session ids from event parts and top-level error messages", () => {
    expect(
      parseOpenCodeLine(`{"type":"text","part":{"sessionID":"part-session","text":"hello"}}`),
    ).toEqual({
      events: [{ type: "text", text: "hello" }],
      sessionId: "part-session",
    });
    expect(parseOpenCodeLine(`{"type":"error","message":"failed"}`)).toEqual({
      events: [{ type: "error", message: "failed" }],
      sessionId: undefined,
    });
  });
});
