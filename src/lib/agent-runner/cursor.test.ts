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
      { summary: "done", taskComplete: true, type: "completion" },
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
});

function parseToolUse(line: string) {
  const event = parseCursorStreamJsonLine(line).event;
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
      taskComplete: true,
      type: "completion",
    });
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
