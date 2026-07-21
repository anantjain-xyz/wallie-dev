import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  class DaytonaNotFoundError extends Error {}
  return {
    Daytona: vi.fn(),
    DaytonaNotFoundError,
    prepare: vi.fn(),
  };
});

vi.mock("@daytona/sdk", () => ({
  Daytona: mocked.Daytona,
  DaytonaNotFoundError: mocked.DaytonaNotFoundError,
}));

vi.mock("./setup", () => ({ prepareSessionSandbox: mocked.prepare }));

import {
  createDaytonaSessionSandbox,
  listRunningDaytonaSandboxes,
  stopDaytonaSandboxById,
  validateDaytonaConnection,
} from "./daytona";
import type { CreateSessionSandboxInput, SandboxConnection } from "./types";

const connection: Extract<SandboxConnection, { provider: "daytona" }> = {
  credentials: {
    apiKey: "daytona_secret",
    apiUrl: "https://daytona.acme.test/api",
    target: "us",
  },
  provider: "daytona",
  revision: "revision-1",
};

function request(overrides: Partial<CreateSessionSandboxInput> = {}): CreateSessionSandboxInput {
  return {
    agentProvider: "claude-code",
    baseBranch: "main",
    branch: "wallie/test",
    installationToken: "gh_secret",
    repoFullName: "acme/app",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    ...overrides,
  };
}

function fixture() {
  const deleteSession = vi.fn().mockResolvedValue(undefined);
  const executeCommand = vi.fn().mockResolvedValue({ exitCode: 0, result: "" });
  const executeSessionCommand = vi.fn().mockResolvedValue({ cmdId: "command-1" });
  const getSessionCommand = vi.fn().mockResolvedValue({ exitCode: 0 });
  const getSessionCommandLogs = vi.fn(
    async (
      _sessionId: string,
      _commandId: string,
      onStdout?: (data: string) => void,
      onStderr?: (data: string) => void,
    ) => {
      if (onStdout || onStderr) {
        onStdout?.("hello");
        onStderr?.("warn");
        return undefined;
      }
      return { stderr: "warn", stdout: "hello" };
    },
  );
  const sandbox = {
    createdAt: "2026-07-21T12:00:00Z",
    delete: vi.fn(),
    fs: {
      downloadFile: vi.fn().mockResolvedValue(Buffer.from("contents")),
      uploadFile: vi.fn(),
    },
    id: "daytona-sandbox-1",
    process: {
      createSession: vi.fn(),
      deleteSession,
      executeCommand,
      executeSessionCommand,
      getSessionCommand,
      getSessionCommandLogs,
    },
    state: "started",
  };
  const dispose = vi.fn();
  const client = {
    [Symbol.asyncDispose]: dispose,
    create: vi.fn().mockResolvedValue(sandbox),
    delete: vi.fn(),
    get: vi.fn().mockResolvedValue(sandbox),
    list: vi.fn(),
  };
  mocked.Daytona.mockImplementation(function MockDaytona() {
    return client;
  });
  return { client, deleteSession, dispose, executeCommand, executeSessionCommand, sandbox };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.prepare.mockResolvedValue(undefined);
});

describe("Daytona sandbox driver", () => {
  it("creates the requested Node resources, labels, and destructive TTL", async () => {
    const { client } = fixture();
    const onSandboxCreated = vi.fn();
    const handle = await createDaytonaSessionSandbox(
      request({ onSandboxCreated, ownerId: "run-1", timeoutMs: 20 * 60_000 }),
      connection,
    );

    expect(mocked.Daytona).toHaveBeenCalledWith({
      apiKey: "daytona_secret",
      apiUrl: "https://daytona.acme.test/api",
      target: "us",
    });
    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        autoStopInterval: 0,
        ephemeral: true,
        image: "node:22-bookworm",
        labels: {
          wallie_owner_id: "run-1",
          wallie_session_id: "session-1",
          wallie_workspace_id: "workspace-1",
        },
        resources: { cpu: 2, disk: 20, memory: 4 },
        ttlMinutes: 30,
      }),
      { timeout: 1200 },
    );
    expect(handle.id).toBe("daytona-sandbox-1");
    expect(onSandboxCreated).toHaveBeenCalledWith({
      provider: "daytona",
      sandboxId: "daytona-sandbox-1",
    });
  });

  it("streams and caches asynchronous session output with safe command joining", async () => {
    const { deleteSession, executeSessionCommand } = fixture();
    const handle = await createDaytonaSessionSandbox(request(), connection);
    const process = await handle.exec("node", ["-e", "console.log('a b')"], {
      env: { VALUE: "x y" },
    });

    expect(executeSessionCommand).toHaveBeenCalledWith(
      expect.stringMatching(/^wallie-/),
      expect.objectContaining({
        command: `cd '/home/daytona/wallie/repo' && env VALUE='x y' 'node' '-e' 'console.log('"'"'a b'"'"')'`,
        runAsync: true,
        suppressInputEcho: true,
      }),
    );
    expect(await process.exitCode).toBe(0);
    expect(await process.output()).toEqual({ stderr: "warn", stdout: "hello" });
    const logs = [];
    for await (const entry of process.logs()) logs.push(entry);
    expect(logs).toEqual([
      { data: "hello", stream: "stdout" },
      { data: "warn", stream: "stderr" },
    ]);
    expect(deleteSession).toHaveBeenCalledTimes(1);
  });

  it("supports files, idempotent deletion, validation, listing, and cleanup by id", async () => {
    const { dispose, executeCommand, sandbox } = fixture();
    const handle = await createDaytonaSessionSandbox(request(), connection);
    await handle.writeFile("/tmp/mode", "secret", { mode: 0o600 });
    expect(sandbox.fs.uploadFile).toHaveBeenCalledWith(Buffer.from("secret"), "/tmp/mode");
    expect(executeCommand).toHaveBeenCalledWith("chmod '600' '/tmp/mode'");
    sandbox.fs.downloadFile.mockRejectedValueOnce(new mocked.DaytonaNotFoundError());
    expect(await handle.readFile("/missing")).toBeNull();
    await handle.stop();
    await handle.stop();
    expect(sandbox.delete).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);

    const validation = fixture();
    validation.client.list.mockReturnValue(
      (async function* () {
        yield validation.sandbox;
      })(),
    );
    expect(await validateDaytonaConnection(connection)).toEqual({ ok: true });
    expect(validation.dispose).toHaveBeenCalledTimes(1);

    const listing = fixture();
    listing.client.list.mockReturnValue(
      (async function* () {
        yield listing.sandbox;
      })(),
    );
    expect(await listRunningDaytonaSandboxes(connection, { workspaceId: "workspace-1" })).toEqual([
      {
        createdAt: Date.parse("2026-07-21T12:00:00Z"),
        id: "daytona-sandbox-1",
        status: "running",
      },
    ]);
    expect(listing.client.list).toHaveBeenCalledWith({
      labels: { wallie_workspace_id: "workspace-1" },
      limit: 100,
    });
    expect(listing.dispose).toHaveBeenCalledTimes(1);

    const cleanup = fixture();
    await stopDaytonaSandboxById("daytona-sandbox-1", connection);
    expect(cleanup.client.get).toHaveBeenCalledWith("daytona-sandbox-1");
    expect(cleanup.client.delete).toHaveBeenCalledWith(cleanup.sandbox, 60, true);
    expect(cleanup.dispose).toHaveBeenCalledTimes(1);
  });

  it("deletes the sandbox and disposes the client when setup fails", async () => {
    const { dispose, sandbox } = fixture();
    mocked.prepare.mockRejectedValueOnce(new Error("setup failed"));
    await expect(createDaytonaSessionSandbox(request(), connection)).rejects.toThrow(
      "setup failed",
    );
    expect(sandbox.delete).toHaveBeenCalledWith(60, true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
