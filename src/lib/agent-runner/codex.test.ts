import { describe, expect, it, vi } from "vitest";

import type { CodexCredential } from "@/lib/codex/contracts";
import { shellQuote } from "@/lib/sandbox/command";
import { FakeSandbox } from "@/lib/sandbox/fake";

import {
  CODEX_EXTERNAL_SANDBOX_FLAG,
  CODEX_SANDBOX_MODE,
  CodexRunner,
  codexExecArgs,
  parseCodexLine,
} from "./codex";

function expectExternalSandboxMode(command: string) {
  expect(command).toContain(shellQuote(CODEX_EXTERNAL_SANDBOX_FLAG));
  expect(command).toContain(`'--sandbox' '${CODEX_SANDBOX_MODE}'`);
  expect(command).toContain("'--cd' '/vercel/sandbox'");
}

describe("CodexRunner", () => {
  const launchCredentials = [
    { expiresAt: null, secret: "cached-api-key", type: "platform_api_key" },
    { expiresAt: null, secret: "cached-access-token", type: "codex_access_token" },
    {
      authCacheLastRefresh: null,
      credentialGeneration: "11111111-1111-4111-8111-111111111111",
      credentialVersion: 1,
      expiresAt: null,
      reconnectReason: null,
      reconnectRequired: false,
      secret: "cached-auth-json",
      type: "chatgpt_auth_json",
      userId: "user-1",
    },
  ] satisfies CodexCredential[];

  it.each(
    launchCredentials.flatMap((credential) =>
      ["prompt", "auth directory"].map((setup) => ({ credential, setup, type: credential.type })),
    ),
  )(
    "blocks $type revoked during $setup setup without using cached credentials",
    async ({ credential, setup }) => {
      const sandbox = new FakeSandbox();
      let memberActive = true;
      let releaseSetup!: () => void;
      const pendingSetup = new Promise<void>((resolve) => {
        releaseSetup = resolve;
      });
      let markSetupStarted!: () => void;
      const setupStarted = new Promise<void>((resolve) => {
        markSetupStarted = resolve;
      });
      const writeFile = sandbox.writeFile.bind(sandbox);
      vi.spyOn(sandbox, "writeFile").mockImplementation(async (...args) => {
        if (setup === "prompt") {
          markSetupStarted();
          await pendingSetup;
        }
        await writeFile(...args);
      });
      const exec = sandbox.exec.bind(sandbox);
      vi.spyOn(sandbox, "exec").mockImplementation(async (...args) => {
        if (setup === "auth directory" && args[1]?.[1]?.startsWith("mkdir -p ")) {
          markSetupStarted();
          await pendingSetup;
        }
        return exec(...args);
      });
      const loadCredential = vi.fn(async () => {
        if (!memberActive) throw new Error("Session owner membership revoked");
        return credential;
      });
      const runner = new CodexRunner({ credential, loadCredential });
      const run = (async () => {
        for await (const event of runner.start({ sessionId: "s", sandbox, prompt: "p" })) {
          void event;
        }
      })();
      await setupStarted;
      expect(loadCredential).not.toHaveBeenCalled();
      memberActive = false;
      releaseSetup();
      await expect(run).rejects.toThrow("membership revoked");
      expect(loadCredential).toHaveBeenCalledOnce();
      expect([...sandbox.files.keys()]).toEqual([`${sandbox.repoPath}/.wallie-prompt.txt`]);
      expect(sandbox.calls).toEqual([
        expect.objectContaining({ args: ["-lc", expect.stringMatching(/^mkdir -p /)] }),
      ]);
    },
  );

  it.each(launchCredentials)("delivers freshly loaded $type after setup", async (credential) => {
    const sandbox = new FakeSandbox();
    const fresh = { ...credential, secret: "fresh-authorized-secret" };
    const loadCredential = vi.fn(async () => {
      expect(sandbox.files.has(`${sandbox.repoPath}/.wallie-prompt.txt`)).toBe(true);
      expect(sandbox.calls.at(-1)?.args[1]).toMatch(/^mkdir -p /);
      return fresh;
    });
    const store = {
      loadChatGptAuth: vi.fn(),
      markChatGptAuthReconnectRequired: vi.fn(),
      persistChatGptAuthJson: vi.fn(),
    };
    const runner = new CodexRunner({ credential, loadCredential, chatGptAuthStore: store });
    expect(loadCredential).not.toHaveBeenCalled();
    for await (const event of runner.start({ sessionId: "s", sandbox, prompt: "p" })) {
      void event;
    }
    expect(loadCredential).toHaveBeenCalledOnce();
    expect(store.loadChatGptAuth).not.toHaveBeenCalled();
    const cli = sandbox.calls.at(-1)!;
    if (credential.type === "chatgpt_auth_json") {
      expect(await sandbox.readFile(`${sandbox.repoPath}/.codex/auth.json`)).toBe(fresh.secret);
    } else {
      expect(cli.opts.env).toMatchObject(
        credential.type === "platform_api_key"
          ? { OPENAI_API_KEY: fresh.secret, CODEX_API_KEY: fresh.secret }
          : { CODEX_ACCESS_TOKEN: fresh.secret },
      );
    }
    expect(JSON.stringify(sandbox.calls)).not.toContain(credential.secret);
  });

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

  it("builds Codex exec args for Vercel's external sandbox boundary", () => {
    expect(codexExecArgs("gpt-5.5", "/vercel/sandbox")).toEqual([
      "exec",
      "--model",
      "gpt-5.5",
      "--sandbox",
      CODEX_SANDBOX_MODE,
      "-c",
      'model_reasoning_effort="xhigh"',
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      "mcp_servers={}",
      "-c",
      "apps.github.enabled=false",
      "--ignore-user-config",
      CODEX_EXTERNAL_SANDBOX_FLAG,
      "--cd",
      "/vercel/sandbox",
      "--json",
      "-",
    ]);
  });

  it("passes the configured reasoning effort to Codex", () => {
    expect(codexExecArgs("gpt-5.6-sol", "/vercel/sandbox", "max")).toContain(
      'model_reasoning_effort="max"',
    );
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
      effort: "max",
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
    expect(call.args[1]).toContain("codex 'exec' '--model' 'gpt-5.6-sol'");
    expect(call.args[1]).toContain(`'-c' 'model_reasoning_effort="max"'`);
    expect(call.args[1]).toContain(`'-c' 'cli_auth_credentials_store="file"'`);
    expect(call.args[1]).toContain(`'-c' 'mcp_servers={}'`);
    expect(call.args[1]).toContain(`'-c' 'apps.github.enabled=false'`);
    expect(call.args[1]).not.toContain("'--disable' 'apps'");
    expectExternalSandboxMode(call.args[1]!);
    expect(call.args[1]).toContain("< '/vercel/sandbox/.wallie-prompt.txt'");
    expect(call.opts.env).toMatchObject({
      CODEX_ACCESS_TOKEN: "tok",
      CODEX_HOME: "/vercel/sandbox/.codex",
      GIT_AUTHOR_EMAIL: "287554934+wallie-dev[bot]@users.noreply.github.com",
      GIT_AUTHOR_NAME: "wallie-dev[bot]",
      GIT_COMMITTER_EMAIL: "287554934+wallie-dev[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "wallie-dev[bot]",
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
    expectExternalSandboxMode(execCall.args[1]!);
    expect(execCall.opts.env).toMatchObject({
      CODEX_API_KEY: "sk-test",
      OPENAI_API_KEY: "sk-test",
    });
    expect(execCall.opts.env).not.toHaveProperty("CODEX_ACCESS_TOKEN");
    expect(execCall.args[1]).not.toContain("codex login --with-access-token");
  });

  it("reloads the latest ChatGPT auth without a lease and persists refreshed auth.json", async () => {
    const configuredAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "configured-access-token-value",
        refresh_token: "configured-refresh-token-value",
      },
    });
    const currentAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "current-access-token-value",
        refresh_token: "current-refresh-token-value",
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
          currentAuthJson,
        );
        void call;
        sandbox.files.set("/vercel/sandbox/.codex/auth.json", {
          data: Buffer.from(refreshedAuthJson, "utf8"),
          mode: 0o600,
        });
        return [{ data: `{"type":"result","summary":"done"}\n`, stream: "stdout" }];
      },
    );
    const currentCredential = {
      authCacheLastRefresh: null,
      credentialGeneration: "22222222-2222-4222-8222-222222222222",
      credentialVersion: 8,
      expiresAt: null,
      reconnectReason: null,
      reconnectRequired: false,
      secret: currentAuthJson,
      type: "chatgpt_auth_json" as const,
      userId: "user-1",
    };
    const store = {
      loadChatGptAuth: vi.fn().mockResolvedValue(currentCredential),
      markChatGptAuthReconnectRequired: vi.fn(),
      persistChatGptAuthJson: vi.fn().mockResolvedValue(true),
    };

    const runner = new CodexRunner({
      chatGptAuthStore: store,
      credential: {
        authCacheLastRefresh: null,
        credentialGeneration: "11111111-1111-4111-8111-111111111111",
        credentialVersion: 7,
        expiresAt: null,
        reconnectReason: null,
        reconnectRequired: false,
        secret: configuredAuthJson,
        type: "chatgpt_auth_json",
        userId: "user-1",
      },
    });

    const events = [];
    for await (const ev of runner.start({
      prompt: "p",
      sandbox,
      sessionId: "s",
    })) {
      events.push(ev);
    }

    expect(events).toContainEqual({ type: "completion", taskComplete: true, summary: "done" });
    expect(store.loadChatGptAuth).toHaveBeenCalledWith({ userId: "user-1" });
    expect(store.persistChatGptAuthJson).toHaveBeenCalledWith({
      authJson: refreshedAuthJson,
      metadata: {
        accountEmail: null,
        accountId: null,
        lastRefresh: "2026-05-19T00:00:00.000Z",
      },
      previousCredentialGeneration: "22222222-2222-4222-8222-222222222222",
      previousCredentialVersion: 8,
      userId: "user-1",
    });
    expect(sandbox.calls[0]?.args[1]).toBe("mkdir -p '/vercel/sandbox/.codex'");
    expectExternalSandboxMode(sandbox.calls[1]?.args[1] ?? "");
    expect(sandbox.calls[1]?.opts.env).toMatchObject({
      CI: "1",
      CODEX_HOME: "/vercel/sandbox/.codex",
      GIT_AUTHOR_EMAIL: "287554934+wallie-dev[bot]@users.noreply.github.com",
      GIT_AUTHOR_NAME: "wallie-dev[bot]",
      GIT_COMMITTER_EMAIL: "287554934+wallie-dev[bot]@users.noreply.github.com",
      GIT_COMMITTER_NAME: "wallie-dev[bot]",
    });
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
    const credential = {
      authCacheLastRefresh: null,
      credentialGeneration: "11111111-1111-4111-8111-111111111111",
      credentialVersion: 7,
      expiresAt: null,
      reconnectReason: null,
      reconnectRequired: false,
      secret: authJson,
      type: "chatgpt_auth_json" as const,
      userId: "user-1",
    };
    const store = {
      loadChatGptAuth: vi.fn().mockResolvedValue(credential),
      markChatGptAuthReconnectRequired: vi.fn(),
      persistChatGptAuthJson: vi.fn().mockResolvedValue(true),
    };
    const runner = new CodexRunner({
      chatGptAuthStore: store,
      credential,
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
    const rewrittenAuthJson = JSON.stringify({
      auth_mode: "chatgpt",
      last_refresh: "2026-05-19T00:00:00.000Z",
      tokens: {
        access_token: "invalid-refreshed-access-token",
        refresh_token: "invalid-refreshed-refresh-token",
      },
    });
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (call) => call.args[1]?.includes("mkdir -p '/vercel/sandbox/.codex'") ?? false,
      [],
    );
    sandbox.scriptExec(
      (call) => call.args[1]?.includes("codex 'exec'") ?? false,
      () => {
        sandbox.files.set("/vercel/sandbox/.codex/auth.json", {
          data: Buffer.from(rewrittenAuthJson, "utf8"),
          mode: 0o600,
        });
        return [{ data: "401 unauthorized\n", stream: "stderr" }];
      },
      { exitCode: 1 },
    );
    const credential = {
      authCacheLastRefresh: null,
      credentialGeneration: "11111111-1111-4111-8111-111111111111",
      credentialVersion: 7,
      expiresAt: null,
      reconnectReason: null,
      reconnectRequired: false,
      secret: authJson,
      type: "chatgpt_auth_json" as const,
      userId: "user-1",
    };
    const store = {
      loadChatGptAuth: vi.fn().mockResolvedValue(credential),
      markChatGptAuthReconnectRequired: vi.fn(),
      persistChatGptAuthJson: vi.fn().mockResolvedValue(true),
    };
    const runner = new CodexRunner({
      chatGptAuthStore: store,
      credential,
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
      previousCredentialGeneration: "11111111-1111-4111-8111-111111111111",
      previousCredentialVersion: 7,
      reason: "The saved ChatGPT Codex sign-in is no longer valid. Reconnect Codex in Settings.",
      userId: "user-1",
    });
    expect(store.persistChatGptAuthJson).not.toHaveBeenCalled();
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

  it("surfaces a targeted error when Codex's inner sandbox fails under Vercel", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [{ data: "bwrap: No permissions to create a new namespace\n", stream: "stderr" }],
      {
        exitCode: 1,
      },
    );

    const runner = new CodexRunner({
      credential: { expiresAt: null, secret: "tok", type: "codex_access_token" },
    });
    const events = [];
    for await (const ev of runner.start({ sessionId: "s", sandbox, prompt: "p" })) {
      events.push(ev);
    }

    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toContain("inner Bubblewrap sandbox");
    expect((events[0] as { message: string }).message).toContain(CODEX_EXTERNAL_SANDBOX_FLAG);
    expect((events[0] as { message: string }).message).toContain(
      "bwrap: No permissions to create a new namespace",
    );
  });

  it("does not classify unrelated bwrap stderr as a Vercel inner sandbox failure", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      "bash",
      [{ data: "bwrap failed while parsing an unrelated argument\n", stream: "stderr" }],
      {
        exitCode: 1,
      },
    );

    const runner = new CodexRunner({
      credential: { expiresAt: null, secret: "tok", type: "codex_access_token" },
    });
    const events = [];
    for await (const ev of runner.start({ sessionId: "s", sandbox, prompt: "p" })) {
      events.push(ev);
    }

    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).not.toContain("inner Bubblewrap sandbox");
    expect((events[0] as { message: string }).message).toContain(
      "bwrap failed while parsing an unrelated argument",
    );
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
