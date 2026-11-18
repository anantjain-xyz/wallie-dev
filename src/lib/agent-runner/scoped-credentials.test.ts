import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { FakeSandbox } from "@/lib/sandbox/fake";

import { ClaudeCodeRunner } from "./claude-code";
import { CodexRunner } from "./codex";
import { CursorRunner } from "./cursor";
import { OpenCodeRunner } from "./opencode";
import { prepareRunnerDirectory } from "./safety";
import { withRunnerCredentials } from "./scoped-credentials";
import { harnessPath } from "./test-helpers";
import type { AgentEvent, AgentRunner } from "./types";

const fixtureCredential = "wallie-test-scoped-key-123456";

async function collect(events: AsyncIterable<AgentEvent>) {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("scoped agent credential delivery", () => {
  it.each<[AgentRunner, string]>([
    [
      new CodexRunner({
        credential: { type: "platform_api_key", expiresAt: null, secret: fixtureCredential },
      }),
      "credential.env",
    ],
    [new ClaudeCodeRunner({ credential: { secret: fixtureCredential } }), "credential.env"],
    [
      new CursorRunner({
        loadCredential: async () => ({ scope: "factory", secret: fixtureCredential }),
      }),
      "credential.env",
    ],
    [new OpenCodeRunner({ credential: { secret: fixtureCredential } }), "data/opencode/auth.json"],
  ])(
    "keeps the $provider credential out of command and trace payloads",
    async (runner, relativePath) => {
      const sandbox = new FakeSandbox();
      sandbox.scriptExec(
        (call) =>
          call.cmd === "bash" &&
          (call.args.includes("wallie-credential") ||
            call.args.some((arg) => /^opencode /m.test(arg))),
        [{ stream: "stderr", data: `A provider failure included ${fixtureCredential}` }],
        { exitCode: 1 },
      );
      const onSensitiveValue = vi.fn();

      const events = await collect(
        runner.start({
          sandbox,
          sessionId: "session-fixture",
          prompt: "Test scoped runtime cleanup.",
          scopedCredential: true,
          onSensitiveValue,
        }),
      );

      const path = harnessPath(sandbox, relativePath);
      expect(sandbox.files.get(path)).toMatchObject({ mode: 0o600 });
      expect(await sandbox.readFile(path)).toContain(fixtureCredential);
      expect(sandbox.calls).toContainEqual(
        expect.objectContaining({ cmd: "rm", args: ["-f", "--", path] }),
      );
      expect(JSON.stringify(sandbox.calls)).not.toContain(fixtureCredential);
      expect(JSON.stringify(events)).not.toContain(fixtureCredential);
      expect(events).toContainEqual(
        expect.objectContaining({ type: "error", message: expect.stringContaining("[REDACTED]") }),
      );
      expect(onSensitiveValue).toHaveBeenCalledWith(fixtureCredential);
    },
  );

  it("unlinks the temporary environment before the credential-bearing process starts", async () => {
    const sandbox = new FakeSandbox(undefined, { passthroughExec: true });
    const directory = await prepareRunnerDirectory("scope-fixture", sandbox);
    const path = `${directory}/credential.env`;
    const quotedCredential = "synthetic'value; with spaces";
    try {
      const events = await collect(
        withRunnerCredentials(
          { sandbox, sessionId: "session-fixture", prompt: "Fixture", scopedCredential: true },
          async function* (safety, material) {
            if (!material) throw new Error("Missing scoped writer.");
            safety.addSecret(quotedCredential);
            const command = await material.exec(
              "bash",
              ["-c", 'test ! -e "$1" && printf "%s" "$TEST_API_KEY"', "fixture", path],
              { cwd: sandbox.repoPath, env: { SHELLOPTS: "verbose:xtrace" } },
              { path, values: { TEST_API_KEY: quotedCredential } },
            );
            expect(await command.exitCode).toBe(0);
            const output = await command.output();
            expect(output.stderr).not.toContain("synthetic");
            yield { type: "text", text: output.stdout };
          },
        ),
      );
      expect(events).toEqual([{ type: "text", text: "[REDACTED]" }]);
      expect(JSON.stringify(sandbox.calls)).not.toContain(quotedCredential);
      expect(existsSync(path)).toBe(false);
    } finally {
      await sandbox.exec("rm", ["-rf", "--", directory], { cwd: "/tmp" });
      await sandbox.stop();
    }
  });

  it("removes a partial auth upload after an SDK error without surfacing the uploaded content", async () => {
    const sandbox = new FakeSandbox();
    const writeFile = sandbox.writeFile.bind(sandbox);
    vi.spyOn(sandbox, "writeFile").mockImplementation(async (path, content, options) => {
      await writeFile(path, content, options);
      if (path.endsWith("auth.json")) throw new Error(`SDK echoed ${content}`);
    });
    const runner = new OpenCodeRunner({ credential: { secret: fixtureCredential } });

    await expect(
      collect(
        runner.start({
          sandbox,
          sessionId: "session-fixture",
          prompt: "Fixture",
          scopedCredential: true,
        }),
      ),
    ).rejects.toThrow("Could not stage the scoped credential in the sandbox.");

    expect(sandbox.calls).toContainEqual(
      expect.objectContaining({
        cmd: "rm",
        args: ["-f", "--", harnessPath(sandbox, "data/opencode/auth.json")],
      }),
    );
    expect(sandbox.calls.some((call) => call.cmd === "bash")).toBe(false);
  });

  it("withholds a successful completion when the sandbox cannot verify secret cleanup", async () => {
    const sandbox = new FakeSandbox();
    sandbox.scriptExec("rm", [], { exitCode: 1 });
    const runner = new OpenCodeRunner({ credential: { secret: fixtureCredential } });
    const completed = vi.fn();
    const consume = async () => {
      for await (const event of runner.start({
        sandbox,
        sessionId: "session-fixture",
        prompt: "Fixture",
        scopedCredential: true,
      })) {
        if (event.type === "completion" && event.taskComplete) completed();
      }
    };
    await expect(consume()).rejects.toMatchObject({ name: "ScopedCredentialCleanupError" });
    expect(completed).not.toHaveBeenCalled();
  });

  it("kills an aborted provider and removes authentication even when the consumer has not drained the iterator", async () => {
    const sandbox = new FakeSandbox();
    const exec = sandbox.exec.bind(sandbox);
    const controller = new AbortController();
    const authPath = "/tmp/scoped-process-fixture/auth.json";
    let finish: (code: number) => void = () => undefined;
    const exitCode = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const kill = vi.fn(async () => finish(137));
    vi.spyOn(sandbox, "exec").mockImplementation(async (cmd, args, options) => {
      if (cmd !== "fixture-agent") return exec(cmd, args, options);
      return {
        exitCode,
        kill,
        logs: async function* () {},
        output: async () => ({ stdout: "", stderr: "" }),
      };
    });
    const iterator = withRunnerCredentials(
      {
        sandbox,
        sessionId: "session-fixture",
        prompt: "Fixture",
        scopedCredential: true,
        signal: controller.signal,
      },
      async function* (safety, material) {
        if (!material) throw new Error("Missing scoped writer.");
        safety.addSecret(fixtureCredential);
        await material.writeFile(authPath, fixtureCredential);
        await material.exec("fixture-agent", [], { signal: controller.signal });
        yield { type: "progress", text: "Agent is running" };
      },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    controller.abort();
    await vi.waitFor(() =>
      expect(sandbox.calls).toContainEqual(
        expect.objectContaining({ cmd: "rm", args: ["-f", "--", authPath] }),
      ),
    );
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await iterator.return?.();
  });
});
