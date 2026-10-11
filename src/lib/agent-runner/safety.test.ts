import { rmSync, statSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";
import type { AgentProvider, SandboxLogEntry } from "@/lib/sandbox/types";

import { ClaudeCodeRunner } from "./claude-code";
import { CodexRunner } from "./codex";
import { CursorRunner } from "./cursor";
import { OpenCodeRunner } from "./opencode";
import { AgentOutputSafety } from "./safety";
import type { AgentEvent, AgentRunner } from "./types";

const providerSecret = "synthetic-provider-credential";
const githubSecret = "synthetic-github-token";
const providers = ["codex", "claude-code", "cursor", "opencode"] as const;

function runnerFor(provider: AgentProvider, secret = providerSecret): AgentRunner {
  switch (provider) {
    case "codex":
      return new CodexRunner({
        loadCredential: async () => ({ type: "platform_api_key", expiresAt: null, secret }),
      });
    case "claude-code":
      return new ClaudeCodeRunner({ loadCredential: async () => ({ secret }) });
    case "cursor":
      return new CursorRunner({
        loadCredential: async () => ({
          secret,
          expiresAt: "2026-12-31T00:00:00.000Z",
          generation: "generation",
          userId: "user",
        }),
      });
    case "opencode":
      return new OpenCodeRunner({ loadAuth: async () => ({ credential: { secret } }) });
  }
}

function textLine(provider: AgentProvider, text: string): string {
  switch (provider) {
    case "codex":
      return JSON.stringify({ type: "text", text });
    case "claude-code":
    case "cursor":
      return JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    case "opencode":
      return JSON.stringify({ type: "text", part: { text } });
  }
}

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

async function* emit(...events: AgentEvent[]): AsyncIterable<AgentEvent> {
  yield* events;
}

describe("runner credential boundary", () => {
  it.each(providers)("redacts %s output split at every transport boundary", async (provider) => {
    const sandbox = new FakeSandbox();
    const raw = `${textLine(provider, `${providerSecret} ${githubSecret}`)}\n`;
    const logs: SandboxLogEntry[] = [...raw].map((data) => ({ stream: "stdout", data }));
    sandbox.scriptExec(
      (call) => call.cmd === "bash" && !call.args[1]?.startsWith("mkdir -p "),
      logs,
    );
    const events = await collect(
      runnerFor(provider).start({
        sandbox,
        prompt: "task",
        sessionId: "session",
        secrets: [githubSecret],
      }),
    );
    expect(events).toContainEqual({ type: "text", text: "[REDACTED] [REDACTED]" });
    expect(JSON.stringify(events)).not.toContain(providerSecret);
    expect(JSON.stringify(events)).not.toContain(githubSecret);
  });

  it.each(providers)("redacts %s stderr before truncating a credential", async (provider) => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec(
      (call) => call.cmd === "bash" && !call.args[1]?.startsWith("mkdir -p "),
      [{ stream: "stderr", data: `${"!".repeat(495)}${providerSecret} ${githubSecret}` }],
      { exitCode: 1 },
    );
    const events = await collect(
      runnerFor(provider).start({
        sandbox,
        prompt: "task",
        sessionId: "session",
        secrets: [githubSecret],
      }),
    );
    const error = events.find((event) => event.type === "error");
    expect(error).toBeDefined();
    expect(JSON.stringify(error)).not.toContain(providerSecret.slice(0, 5));
  });

  it.each(providers)("sanitizes %s SDK errors after credential delivery", async (provider) => {
    const sandbox = new FakeSandbox();
    const exec = sandbox.exec.bind(sandbox);
    vi.spyOn(sandbox, "exec").mockImplementation(async (...args) => {
      if (args[0] === "bash" && !args[1][1]?.startsWith("mkdir -p ")) {
        throw new Error(`SDK rejected ${providerSecret} ${githubSecret}`, {
          cause: { credential: providerSecret },
        });
      }
      return exec(...args);
    });
    await expect(
      collect(
        runnerFor(provider).start({
          sandbox,
          prompt: "task",
          sessionId: "session",
          secrets: [githubSecret],
        }),
      ),
    ).rejects.toMatchObject({ message: "SDK rejected [REDACTED] [REDACTED]" });
  });

  it("redacts every event field, credential JSON component, and encoded form", async () => {
    const safety = new AgentOutputSafety([githubSecret]);
    const accessToken = "synthetic-access/token";
    const refreshToken = "synthetic-refresh-token";
    const idToken = "synthetic-id-token";
    safety.addSecret(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: accessToken, refresh_token: refreshToken, id_token: idToken },
      }),
    );
    const secretText = `${accessToken} ${encodeURIComponent(accessToken)} ${refreshToken} ${idToken} ${githubSecret}`;
    const events = await collect(
      safety.events(
        emit(
          { type: "tool_use", tool: secretText, input: secretText },
          { type: "completion", taskComplete: true, summary: secretText, finalOutput: secretText },
          { type: "error", message: secretText },
        ),
      ),
    );
    const serialized = JSON.stringify(events);
    for (const secret of [
      accessToken,
      encodeURIComponent(accessToken),
      refreshToken,
      idToken,
      githubSecret,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized.match(/\[REDACTED\]/g)).toHaveLength(25);
  });

  it("holds a token prefix until adjacent text deltas complete it", async () => {
    const safety = new AgentOutputSafety([githubSecret]);
    const events = await collect(
      safety.events(
        emit(
          { type: "text", text: "Result: synthetic-git" },
          { type: "text", text: "hub-token done." },
        ),
      ),
    );
    expect(events.map((event) => (event.type === "text" ? event.text : "")).join("")).toBe(
      "Result: [REDACTED] done.",
    );
  });

  it("redacts fragmented text across interleaved progress and tool events", async () => {
    const safety = new AgentOutputSafety([githubSecret]);
    const events = await collect(
      safety.events(
        emit(
          { type: "text", text: "Result: synthetic-git" },
          { type: "progress", text: "synthetic-git" },
          { type: "tool_use", tool: "read", input: "file" },
          { type: "text", text: "hub-token done." },
          { type: "progress", text: "hub-token" },
        ),
      ),
    );
    expect(events).toEqual([
      { type: "text", text: "Result: [REDACTED]" },
      { type: "progress", text: "[REDACTED]" },
      { type: "tool_use", tool: "read", input: "file" },
      { type: "text", text: " done." },
      { type: "progress", text: "" },
    ]);
  });

  it("preserves ordinary prose and event boundaries when a suffix is not a secret", async () => {
    const safety = new AgentOutputSafety([githubSecret]);
    const original: AgentEvent[] = [
      { type: "text", text: "This is" },
      { type: "tool_use", tool: "read", input: "file" },
      { type: "text", text: "another paragraph." },
      { type: "text", text: "This is" },
      { type: "completion", taskComplete: true, summary: "done" },
    ];
    expect(await collect(safety.events(emit(...original)))).toEqual(original);
  });

  it("redacts short active credentials instead of treating them as diagnostics", async () => {
    const safety = new AgentOutputSafety(["abc"]);
    expect(
      await collect(
        safety.events(
          emit(
            { type: "text", text: "ab" },
            { type: "tool_use", tool: "abc", input: "abc" },
            { type: "text", text: "c" },
          ),
        ),
      ),
    ).toEqual([
      { type: "text", text: "[REDACTED]" },
      { type: "tool_use", tool: "[REDACTED]", input: "[REDACTED]" },
      { type: "text", text: "" },
    ]);
  });

  it("keeps prompt/auth files out of git staging in a repository with no ignore rules", async () => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    const directories: string[] = [];
    const authJson = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "synthetic-chatgpt-access-token",
        refresh_token: "synthetic-chatgpt-refresh-token",
      },
    });
    const credential = {
      authCacheLastRefresh: null,
      credentialGeneration: "generation",
      credentialVersion: 1,
      expiresAt: null,
      reconnectReason: null,
      reconnectRequired: false,
      secret: authJson,
      type: "chatgpt_auth_json" as const,
      userId: "user",
    };
    const runners = [
      ...providers.map((provider) => runnerFor(provider)),
      new CodexRunner({
        loadCredential: async () => credential,
        chatGptAuthStore: {
          loadChatGptAuth: async () => credential,
          markChatGptAuthReconnectRequired: async () => {},
          persistChatGptAuthJson: async () => true,
        },
      }),
    ];
    try {
      for (const runner of runners) {
        // Skip external CLIs; all directory/file operations and Git below are real.
        sandbox.scriptExec("bash", []);
        if (runner.provider === "codex") sandbox.scriptExec("bash", []);
        await collect(runner.start({ sandbox, prompt: "private task", sessionId: "session" }));
      }
      directories.push(
        ...sandbox.calls.filter((call) => call.cmd === "mkdir").map((call) => call.args[2]!),
      );
      expect(new Set(directories).size).toBe(runners.length);
      for (const directory of directories) expect(statSync(directory).mode & 0o777).toBe(0o700);
      for (const [path] of sandbox.files) {
        expect(path.startsWith(`${sandbox.repoPath}/`)).toBe(false);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      await expect((await sandbox.exec("git", ["add", "."])).exitCode).resolves.toBe(0);
      const diff = await sandbox.exec("git", ["diff", "--cached", "--name-only"]);
      expect((await diff.output()).stdout).toBe("");
    } finally {
      for (const call of sandbox.calls.filter((call) => call.cmd === "mkdir")) {
        const directory = call.args[2]!;
        if (directory.startsWith("/tmp/wallie-"))
          rmSync(directory, { recursive: true, force: true });
      }
      await sandbox.stop();
    }
  });
});
