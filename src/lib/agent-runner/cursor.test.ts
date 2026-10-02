import { describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

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
      { text: "working", type: "text" },
      { summary: "done", finalOutput: "done", taskComplete: true, type: "completion" },
    ]);
    expect(await sandbox.readFile("/vercel/sandbox/.wallie-cursor-prompt.txt")).toBe(
      "Implement this",
    );
    expect(sandbox.calls[0]?.args[1]).toContain("'--model' 'composer-2'");
    expect(sandbox.calls[0]?.args[1]).toContain("'--resume' 'previous'");
    expect(sandbox.calls[0]?.opts.env).toMatchObject({
      CI: "1",
      CURSOR_API_KEY: "cursor-key",
    });
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
    expect(sandbox.calls).toHaveLength(0);

    activeMember = false;
    const rejected = expect(run).rejects.toThrow(/no longer active/);
    finishPrompt();
    await rejected;

    expect(loadCredential).toHaveBeenCalledOnce();
    expect(readOriginalSecret).not.toHaveBeenCalled();
    expect(sandbox.calls).toHaveLength(0);
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
      expect(sandbox.files.has("/vercel/sandbox/.wallie-cursor-prompt.txt")).toBe(true);
      expect(sandbox.calls).toHaveLength(0);
      return currentCredential;
    });
    const onAuthenticationFailure = vi.fn();
    const runner = new CursorRunner({ credential, loadCredential, onAuthenticationFailure });
    const events = [];

    for await (const event of runner.start({ prompt: "p", sandbox, sessionId: "s" })) {
      events.push(event);
    }

    expect(loadCredential).toHaveBeenCalledOnce();
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]?.opts.env).toMatchObject({ CURSOR_API_KEY: "fresh-cursor-key" });
    expect(sandbox.calls[0]?.opts.env?.CURSOR_API_KEY).not.toBe(credential.secret);
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
    expect(sandbox.calls).toHaveLength(1);
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

    const toolUse = events.find((event) => event.type === "tool_use");
    expect(toolUse).toMatchObject({ tool: "shell", type: "tool_use" });
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("expected tool_use event");
    }
    expect(toolUse.input).not.toContain(secret);
    expect(toolUse.input).toContain("[REDACTED]");
    expect(JSON.parse(toolUse.input)).toMatchObject({
      command: "printenv CURSOR_API_KEY",
      result: { exitCode: 0, stdout: "[REDACTED]" },
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

    const toolUse = events.find((event) => event.type === "tool_use");
    expect(toolUse).toMatchObject({ tool: "shell", type: "tool_use" });
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("expected tool_use event");
    }
    expect(toolUse.input).not.toContain(installationToken);
    expect(toolUse.input).toContain("[REDACTED]");
    expect(JSON.parse(toolUse.input)).toMatchObject({
      command: "printenv GH_TOKEN",
      result: { exitCode: 0, stdout: "[REDACTED]" },
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
  const event = parseCursorStreamJsonLine(line, secrets).event;
  expect(event).toMatchObject({ type: "tool_use" });
  if (!event || event.type !== "tool_use") {
    throw new Error("expected tool_use event");
  }
  return { event, input: JSON.parse(event.input) as Record<string, unknown> };
}

describe("parseCursorStreamJsonLine", () => {
  it("parses assistant, tool, and result records", () => {
    expect(
      parseCursorStreamJsonLine(
        '{"type":"assistant","session_id":"s","message":{"content":[{"type":"text","text":"hello"}]}}',
      ),
    ).toEqual({ event: { text: "hello", type: "text" }, sessionId: "s" });
    expect(
      parseCursorStreamJsonLine(
        '{"type":"tool_call","subtype":"started","tool_call":{"name":"shell","args":{"cmd":"ls"}}}',
      ).event,
    ).toEqual({ input: '{"cmd":"ls"}', tool: "shell", type: "tool_use" });
    expect(parseCursorStreamJsonLine('{"type":"result","result":"done"}').event).toEqual({
      summary: "done",
      finalOutput: "done",
      taskComplete: true,
      type: "completion",
    });
  });

  it("redacts explicit final output and never promotes fallback bookkeeping", () => {
    expect(
      parseCursorStreamJsonLine(JSON.stringify({ type: "result", result: "Final secret-token" }), [
        "secret-token",
      ]).event,
    ).toMatchObject({ finalOutput: "Final [REDACTED]" });
    expect(parseCursorStreamJsonLine(JSON.stringify({ type: "result" })).event).not.toHaveProperty(
      "finalOutput",
    );
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
      ).event,
    ).toEqual({ input: '{"path":"file.txt"}', tool: "read", type: "tool_use" });

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

  it("summarizes completed tool results without dumping file or stdout contents", () => {
    const stdout = "x".repeat(4000);
    const completed = parseToolUse(
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
    expect(completed.input).toMatchObject({
      command: "cat huge.log",
      result: { exitCode: 0, stderr: "" },
    });
    expect((completed.input.result as { stdout: string }).stdout).toBe(`${"x".repeat(500)}…`);
    expect(completed.event.input).not.toContain(stdout);

    const readCompleted = parseToolUse(
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
    expect(readCompleted.input).toEqual({
      path: "README.md",
      result: {
        exceededLimit: false,
        isEmpty: false,
        totalChars: 1254,
        totalLines: 54,
      },
    });
  });

  it("redacts known secrets from tool results before truncation", () => {
    const secret = "sk-cursor-live-secret-value-12345";
    const completed = parseToolUse(
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
    expect(completed.event.input).not.toContain(secret);
    expect((completed.input.result as { stdout: string }).stdout).toBe(
      `[REDACTED]\n${"x".repeat(489)}…`,
    );
  });

  it("redacts a sandbox GitHub token from tool results before truncation", () => {
    const installationToken = "ghs_sandbox-installation-token-12345";
    const completed = parseToolUse(
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
    expect(completed.event.input).not.toContain(installationToken);
    expect((completed.input.result as { stdout: string }).stdout).toBe(
      `[REDACTED]\n${"x".repeat(489)}…`,
    );
  });

  it("never uses subtype as the tool name", () => {
    expect(
      parseCursorStreamJsonLine('{"type":"tool_call","subtype":"started","tool_call":{}}').event,
    ).toEqual({ input: "{}", tool: "tool", type: "tool_use" });
    expect(parseCursorStreamJsonLine('{"type":"tool_call","subtype":"completed"}').event).toEqual({
      input: "{}",
      tool: "tool",
      type: "tool_use",
    });
  });
});
