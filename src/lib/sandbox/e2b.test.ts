import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  class FileNotFoundError extends Error {}
  class CommandExitError extends Error {
    exitCode = 1;
    stderr = "failed";
    stdout = "";
  }
  return {
    CommandExitError,
    FileNotFoundError,
    connect: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    prepare: vi.fn(),
  };
});

vi.mock("e2b", () => ({
  CommandExitError: mocked.CommandExitError,
  FileNotFoundError: mocked.FileNotFoundError,
  Sandbox: {
    connect: mocked.connect,
    create: mocked.create,
    list: mocked.list,
  },
}));

vi.mock("./setup", () => ({ prepareSessionSandbox: mocked.prepare }));

import {
  createE2BSessionSandbox,
  listRunningE2BSandboxes,
  stopE2BSandboxById,
  validateE2BConnection,
} from "./e2b";
import type { CreateSessionSandboxInput, SandboxConnection } from "./types";

const connection: Extract<SandboxConnection, { provider: "e2b" }> = {
  credentials: { apiKey: "e2b_secret" },
  provider: "e2b",
  revision: "revision-1",
};

function request(overrides: Partial<CreateSessionSandboxInput> = {}): CreateSessionSandboxInput {
  return {
    agentProvider: "codex",
    baseBranch: "main",
    branch: "wallie/test",
    installationToken: "gh_secret",
    repoFullName: "acme/app",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function e2bSandbox() {
  const commandKill = vi.fn();
  const command = {
    kill: commandKill,
    stderr: "warn",
    stdout: "hello",
    wait: vi.fn().mockResolvedValue({ exitCode: 0, stderr: "warn", stdout: "hello" }),
  };
  const run = vi.fn(
    async (
      commandText: string,
      options?: { onStderr?: (data: string) => void; onStdout?: (data: string) => void },
    ) => {
      if (commandText.startsWith("chmod ")) return { exitCode: 0, stderr: "", stdout: "" };
      options?.onStdout?.("hello");
      options?.onStderr?.("warn");
      return command;
    },
  );
  const sandbox = {
    commands: { run },
    files: {
      read: vi.fn().mockResolvedValue("contents"),
      write: vi.fn(),
    },
    kill: vi.fn(),
    sandboxId: "e2b-sandbox-1",
  };
  return { command, commandKill, run, sandbox };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.prepare.mockResolvedValue(undefined);
});

describe("E2B sandbox driver", () => {
  it("creates with Wallie metadata and timeout policy", async () => {
    const fixture = e2bSandbox();
    mocked.create.mockResolvedValue(fixture.sandbox);
    const onSandboxCreated = vi.fn();

    const handle = await createE2BSessionSandbox(
      request({ onSandboxCreated, ownerId: "run-1", timeoutMs: 90_000 }),
      connection,
    );

    expect(handle.id).toBe("e2b-sandbox-1");
    expect(mocked.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: { onTimeout: "kill" },
        metadata: {
          wallie_owner_id: "run-1",
          wallie_session_id: "session-1",
          wallie_workspace_id: "workspace-1",
        },
        timeoutMs: 90_000,
      }),
    );
    expect(onSandboxCreated).toHaveBeenCalledWith({
      provider: "e2b",
      sandboxId: "e2b-sandbox-1",
    });
    expect(mocked.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "e2b", repoAlreadyCloned: false }),
    );
  });

  it("preserves command arguments and replays cached logs and output", async () => {
    const fixture = e2bSandbox();
    mocked.create.mockResolvedValue(fixture.sandbox);
    const handle = await createE2BSessionSandbox(request(), connection);
    const process = await handle.exec("node", ["-e", "console.log('a b')"]);

    expect(fixture.run).toHaveBeenCalledWith(
      `'node' '-e' 'console.log('"'"'a b'"'"')'`,
      expect.objectContaining({ background: true, cwd: "/home/user/wallie/repo", timeoutMs: 0 }),
    );
    expect(await process.output()).toEqual({ stderr: "warn", stdout: "hello" });
    expect(await process.exitCode).toBe(0);
    const logs = [];
    for await (const entry of process.logs()) logs.push(entry);
    expect(logs).toEqual([
      { data: "hello", stream: "stdout" },
      { data: "warn", stream: "stderr" },
    ]);
  });

  it("supports file modes, missing files, abort, and idempotent destruction", async () => {
    const fixture = e2bSandbox();
    mocked.create.mockResolvedValue(fixture.sandbox);
    const controller = new AbortController();
    controller.abort();
    const handle = await createE2BSessionSandbox(request(), connection);
    const process = await handle.exec("sleep", ["10"], { signal: controller.signal });
    await vi.waitFor(() => expect(fixture.commandKill).toHaveBeenCalledTimes(1));
    await process.exitCode;

    await handle.writeFile("/tmp/mode", "secret", { mode: 0o600 });
    expect(fixture.sandbox.files.write).toHaveBeenCalledWith("/tmp/mode", "secret");
    expect(fixture.run).toHaveBeenCalledWith("chmod '600' '/tmp/mode'");
    fixture.sandbox.files.read.mockRejectedValueOnce(new mocked.FileNotFoundError());
    expect(await handle.readFile("/missing")).toBeNull();

    await handle.stop();
    await handle.stop();
    expect(fixture.sandbox.kill).toHaveBeenCalledTimes(1);
  });

  it("cleans up when setup fails and supports validation/list/stop", async () => {
    const fixture = e2bSandbox();
    mocked.create.mockResolvedValue(fixture.sandbox);
    mocked.prepare.mockRejectedValueOnce(new Error("setup failed"));
    await expect(createE2BSessionSandbox(request(), connection)).rejects.toThrow("setup failed");
    expect(fixture.sandbox.kill).toHaveBeenCalledTimes(1);

    const paginator = {
      hasNext: true,
      nextItems: vi.fn(async function (this: { hasNext: boolean }) {
        this.hasNext = false;
        return [
          {
            sandboxId: "e2b-running",
            startedAt: new Date("2026-07-21T12:00:00Z"),
            state: "running",
          },
        ];
      }),
    };
    mocked.list.mockReturnValue(paginator);
    expect(await validateE2BConnection(connection)).toEqual({ ok: true });
    mocked.list.mockReturnValue(paginator);
    paginator.hasNext = true;
    expect(await listRunningE2BSandboxes(connection, { workspaceId: "workspace-1" })).toEqual([
      {
        createdAt: Date.parse("2026-07-21T12:00:00Z"),
        id: "e2b-running",
        status: "running",
      },
    ]);
    const priorKillCalls = fixture.sandbox.kill.mock.calls.length;
    mocked.connect.mockResolvedValue(fixture.sandbox);
    await stopE2BSandboxById("e2b-running", connection);
    expect(mocked.connect).toHaveBeenCalledWith("e2b-running", { apiKey: "e2b_secret" });
    expect(fixture.sandbox.kill).toHaveBeenCalledTimes(priorKillCalls + 1);
  });
});
