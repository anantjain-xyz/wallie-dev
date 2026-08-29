import { describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { CursorRunner, parseCursorStreamJsonLine } from "./cursor";

const credential = {
  expiresAt: "2026-11-27T00:00:00.000Z",
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
});
