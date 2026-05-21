import { describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { CodexRunner, parseCodexLine } from "./codex";

describe("CodexRunner", () => {
  it("has the correct provider name", () => {
    const runner = new CodexRunner({
      credential: { expiresAt: null, secret: "test-token", type: "codex_access_token" },
    });
    expect(runner.provider).toBe("codex");
    expect(runner.requiresSandbox).toBe(true);
  });

  it("implements the AgentRunner interface", () => {
    const runner = new CodexRunner({
      credential: { expiresAt: null, secret: "test-token", type: "codex_access_token" },
    });
    expect(typeof runner.start).toBe("function");
  });

  it("throws when constructed without a credential", () => {
    expect(
      () =>
        new CodexRunner({
          credential: { expiresAt: null, secret: "", type: "codex_access_token" },
        }),
    ).toThrow(/credential/);
  });

  it("throws when started without a sandbox", async () => {
    const runner = new CodexRunner({
      credential: { expiresAt: null, secret: "tok", type: "codex_access_token" },
    });
    const iter = runner.start({ sessionId: "s", prompt: "p" });
    await expect(
      (async () => {
        for await (const _ of iter) {
          void _;
        }
      })(),
    ).rejects.toThrow(/requires a sandbox/);
  });

  it("logs in with a Codex access token before running exec", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (c) => c.cmd === "bash",
      [
        { data: `{"type":"thread.started","thread_id":"thread-1"}\n`, stream: "stdout" },
        { data: `{"type":"turn.started"}\n`, stream: "stdout" },
        { data: `{"type":"text","text":"thinking..."}\n`, stream: "stdout" },
        {
          data: `{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"Drafted product spec"}}\n`,
          stream: "stdout",
        },
        {
          data: `{"type":"tool_call","name":"read_file","arguments":{"path":"a.ts"}}\n`,
          stream: "stdout",
        },
        {
          data: `{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}\n`,
          stream: "stdout",
        },
      ],
    );

    const runner = new CodexRunner({
      credential: { expiresAt: null, secret: "tok", type: "codex_access_token" },
    });
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
      { type: "text", text: "Drafted product spec" },
      { type: "tool_use", tool: "read_file", input: '{"path":"a.ts"}' },
      {
        type: "completion",
        taskComplete: true,
        summary: "Codex turn completed",
        usage: { inputTokens: 10, outputTokens: 4 },
      },
      { type: "completion", taskComplete: true, summary: "Codex session completed" },
    ]);

    expect(await sandbox.readFile("/vercel/sandbox/.codex/auth.json")).toBeNull();
    expect(await sandbox.readFile("/vercel/sandbox/.wallie-prompt.txt")).toBe("Hello Codex");

    // CLI invocation uses bash -lc to log in, then redirect the prompt file as stdin.
    expect(sandbox.calls).toHaveLength(1);
    const [call] = sandbox.calls;
    expect(call.cmd).toBe("bash");
    expect(call.args[0]).toBe("-lc");
    expect(call.args[1]).toContain("mkdir -p '/vercel/sandbox/.codex'");
    expect(call.args[1]).toContain(
      `printf '%s' "$CODEX_ACCESS_TOKEN" | codex login --with-access-token -c 'cli_auth_credentials_store="file"' >/dev/stderr`,
    );
    expect(call.args[1]).toContain("codex 'exec' '--model' 'gpt-5.5'");
    expect(call.args[1]).toContain(`'-c' 'model_reasoning_effort="xhigh"'`);
    expect(call.args[1]).toContain(`'-c' 'cli_auth_credentials_store="file"'`);
    expect(call.args[1]).toContain("< '/vercel/sandbox/.wallie-prompt.txt'");
    expect(call.opts.env).toMatchObject({
      CODEX_ACCESS_TOKEN: "tok",
      CODEX_HOME: "/vercel/sandbox/.codex",
    });
    expect(call.opts.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("injects an OpenAI API key env var for platform API credentials", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", []);

    const runner = new CodexRunner({
      credential: { expiresAt: null, secret: "sk-test", type: "platform_api_key" },
    });
    for await (const _ of runner.start({ sessionId: "s", sandbox, prompt: "p" })) {
      void _;
    }

    expect(sandbox.calls[0]?.args[1]).toBe("mkdir -p '/vercel/sandbox/.codex'");
    const execCall = sandbox.calls[1]!;
    expect(execCall.opts.env).toMatchObject({
      CODEX_API_KEY: "sk-test",
      OPENAI_API_KEY: "sk-test",
    });
    expect(execCall.opts.env).not.toHaveProperty("CODEX_ACCESS_TOKEN");
    expect(execCall.args[1]).not.toContain("codex login --with-access-token");
  });

  it("writes and persists ChatGPT auth.json for subscription credentials", async () => {
    const originalAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-token-value-1234567890",
        refresh_token: "refresh-token-value-1234567890",
      },
    });
    const refreshedAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-05-19T00:00:00.000Z",
      tokens: {
        access_token: "access-token-value-refreshed",
        refresh_token: "refresh-token-value-refreshed",
      },
    });
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (call) => call.args[1]?.includes("mkdir -p '/vercel/sandbox/.codex'") ?? false,
      [],
    );
    sandbox.scriptExec(
      (call) => call.args[1]?.includes("codex 'exec'") ?? false,
      (call) => {
        expect(sandbox.files.get("/vercel/sandbox/.codex/auth.json")?.data.toString("utf8")).toBe(
          originalAuthJson,
        );
        void call;
        sandbox.files.set("/vercel/sandbox/.codex/auth.json", {
          data: Buffer.from(refreshedAuthJson, "utf8"),
          mode: 0o600,
        });
        return [{ data: `{"type":"result","summary":"done"}\n`, stream: "stdout" }];
      },
    );
    const store = {
      acquireChatGptAuthLease: vi.fn().mockResolvedValue({
        authCacheLastRefresh: null,
        credentialVersion: 7,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        secret: originalAuthJson,
        type: "chatgpt_auth_json",
        userId: "user-1",
      }),
      markChatGptAuthReconnectRequired: vi.fn(),
      persistChatGptAuthJson: vi.fn().mockResolvedValue(true),
      releaseChatGptAuthLease: vi.fn(),
    };

    const runner = new CodexRunner({
      chatGptAuthStore: store,
      credential: {
        authCacheLastRefresh: null,
        credentialVersion: 7,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        secret: originalAuthJson,
        type: "chatgpt_auth_json",
        userId: "user-1",
      },
    });

    const events = [];
    for await (const ev of runner.start({
      prompt: "p",
      runId: "00000000-0000-0000-0000-000000000001",
      sandbox,
      sessionId: "s",
    })) {
      events.push(ev);
    }

    expect(events).toContainEqual({ type: "completion", taskComplete: true, summary: "done" });
    expect(store.acquireChatGptAuthLease).toHaveBeenCalledWith({
      leaseExpiresAt: expect.any(String),
      runId: "00000000-0000-0000-0000-000000000001",
      userId: "user-1",
    });
    expect(store.persistChatGptAuthJson).toHaveBeenCalledWith({
      authJson: refreshedAuthJson,
      metadata: {
        accountEmail: null,
        accountId: null,
        lastRefresh: "2026-05-19T00:00:00.000Z",
      },
      previousCredentialVersion: 7,
      runId: "00000000-0000-0000-0000-000000000001",
      userId: "user-1",
    });
    expect(store.releaseChatGptAuthLease).toHaveBeenCalledWith({
      runId: "00000000-0000-0000-0000-000000000001",
      userId: "user-1",
    });
    expect(sandbox.calls[0]?.args[1]).toBe("mkdir -p '/vercel/sandbox/.codex'");
    expect(sandbox.calls[1]?.opts.env).toEqual({ CI: "1", CODEX_HOME: "/vercel/sandbox/.codex" });
  });

  it("does not mark ChatGPT auth reconnect required for token-limit failures", async () => {
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-token-value-1234567890",
        refresh_token: "refresh-token-value-1234567890",
      },
    });
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (call) => call.args[1]?.includes("mkdir -p '/vercel/sandbox/.codex'") ?? false,
      [],
    );
    sandbox.scriptExec(
      (call) => call.args[1]?.includes("codex 'exec'") ?? false,
      [{ data: "context token limit exceeded\n", stream: "stderr" }],
      { exitCode: 1 },
    );
    const store = {
      acquireChatGptAuthLease: vi.fn().mockResolvedValue({
        authCacheLastRefresh: null,
        credentialVersion: 7,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        secret: authJson,
        type: "chatgpt_auth_json",
        userId: "user-1",
      }),
      markChatGptAuthReconnectRequired: vi.fn(),
      persistChatGptAuthJson: vi.fn().mockResolvedValue(true),
      releaseChatGptAuthLease: vi.fn(),
    };
    const runner = new CodexRunner({
      chatGptAuthStore: store,
      credential: {
        authCacheLastRefresh: null,
        credentialVersion: 7,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        secret: authJson,
        type: "chatgpt_auth_json",
        userId: "user-1",
      },
    });

    const events = [];
    for await (const ev of runner.start({
      prompt: "p",
      runId: "00000000-0000-0000-0000-000000000001",
      sandbox,
      sessionId: "s",
    })) {
      events.push(ev);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("context token limit exceeded"),
        type: "error",
      }),
    );
    expect(store.markChatGptAuthReconnectRequired).not.toHaveBeenCalled();
  });

  it("marks ChatGPT auth reconnect required for credential failures", async () => {
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "access-token-value-1234567890",
        refresh_token: "refresh-token-value-1234567890",
      },
    });
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (call) => call.args[1]?.includes("mkdir -p '/vercel/sandbox/.codex'") ?? false,
      [],
    );
    sandbox.scriptExec(
      (call) => call.args[1]?.includes("codex 'exec'") ?? false,
      [{ data: "401 unauthorized\n", stream: "stderr" }],
      { exitCode: 1 },
    );
    const store = {
      acquireChatGptAuthLease: vi.fn().mockResolvedValue({
        authCacheLastRefresh: null,
        credentialVersion: 7,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        secret: authJson,
        type: "chatgpt_auth_json",
        userId: "user-1",
      }),
      markChatGptAuthReconnectRequired: vi.fn(),
      persistChatGptAuthJson: vi.fn().mockResolvedValue(true),
      releaseChatGptAuthLease: vi.fn(),
    };
    const runner = new CodexRunner({
      chatGptAuthStore: store,
      credential: {
        authCacheLastRefresh: null,
        credentialVersion: 7,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        secret: authJson,
        type: "chatgpt_auth_json",
        userId: "user-1",
      },
    });

    for await (const _ of runner.start({
      prompt: "p",
      runId: "00000000-0000-0000-0000-000000000001",
      sandbox,
      sessionId: "s",
    })) {
      void _;
    }

    expect(store.markChatGptAuthReconnectRequired).toHaveBeenCalledWith({
      reason: "The saved ChatGPT Codex sign-in is no longer valid. Reconnect Codex in Settings.",
      runId: "00000000-0000-0000-0000-000000000001",
      userId: "user-1",
    });
  });

  it("throws a lease busy error when another ChatGPT-authenticated run holds the credential", async () => {
    const sandbox = new FakeSandbox();
    const store = {
      acquireChatGptAuthLease: vi.fn().mockResolvedValue(null),
      markChatGptAuthReconnectRequired: vi.fn(),
      persistChatGptAuthJson: vi.fn(),
      releaseChatGptAuthLease: vi.fn(),
    };
    const runner = new CodexRunner({
      chatGptAuthStore: store,
      credential: {
        authCacheLastRefresh: null,
        credentialVersion: 1,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        secret: "{}",
        type: "chatgpt_auth_json",
        userId: "user-1",
      },
    });

    await expect(
      (async () => {
        for await (const _ of runner.start({
          prompt: "p",
          runId: "00000000-0000-0000-0000-000000000001",
          sandbox,
          sessionId: "s",
        })) {
          void _;
        }
      })(),
    ).rejects.toThrow(/already in use/);
    expect(store.releaseChatGptAuthLease).not.toHaveBeenCalled();
  });

  it("emits an error event when the CLI exits non-zero", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("bash", [{ data: "fatal: auth failed\n", stream: "stderr" }], {
      exitCode: 1,
    });

    const runner = new CodexRunner({
      credential: { expiresAt: null, secret: "tok", type: "codex_access_token" },
    });
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

  it("parses current Codex item.completed agent messages as text", () => {
    expect(
      parseCodexLine(
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"artifact-output"}}',
      ),
    ).toEqual({
      type: "text",
      text: "artifact-output",
    });
  });

  it("parses current Codex turn.completed usage as completion metadata", () => {
    expect(
      parseCodexLine(
        '{"type":"turn.completed","usage":{"input_tokens":15762,"cached_input_tokens":2432,"output_tokens":34,"reasoning_output_tokens":26}}',
      ),
    ).toEqual({
      type: "completion",
      taskComplete: true,
      summary: "Codex turn completed",
      usage: { inputTokens: 15762, outputTokens: 34 },
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
