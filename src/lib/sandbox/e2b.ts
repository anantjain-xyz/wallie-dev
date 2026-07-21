import { CommandExitError, FileNotFoundError, Sandbox } from "e2b";

import { SandboxLogBuffer, shellJoin, shellQuote } from "./command";
import { prepareSessionSandbox } from "./setup";
import type {
  CreateSessionSandboxInput,
  RunningSandboxSummary,
  SandboxConnection,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxProviderDriver,
} from "./types";

const REPO_PATH = "/home/user/wallie/repo";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

type E2BConnection = Extract<SandboxConnection, { provider: "e2b" }>;

class E2BSandboxHandle implements SandboxHandle {
  readonly repoPath = REPO_PATH;
  private stopped = false;

  constructor(private readonly sandbox: Sandbox) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  async exec(
    cmd: string,
    args: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecHandle> {
    const logs = new SandboxLogBuffer();
    const command = await this.sandbox.commands.run(shellJoin(cmd, args), {
      background: true,
      cwd: opts.cwd ?? REPO_PATH,
      envs: opts.env,
      onStderr: (data) => logs.push({ data, stream: "stderr" }),
      onStdout: (data) => logs.push({ data, stream: "stdout" }),
      timeoutMs: 0,
    });

    let killed = false;
    const result = command
      .wait()
      .catch((error: unknown) => {
        if (error instanceof CommandExitError) {
          return {
            exitCode: error.exitCode,
            stderr: error.stderr,
            stdout: error.stdout,
          };
        }
        if (killed) {
          return { exitCode: 137, stderr: command.stderr, stdout: command.stdout };
        }
        throw error;
      })
      .finally(() => logs.close());

    const kill = async () => {
      killed = true;
      await command.kill();
    };
    const abort = () => void kill().catch(() => undefined);
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener("abort", abort, { once: true });
    void result
      .finally(() => opts.signal?.removeEventListener("abort", abort))
      .catch(() => undefined);

    return {
      exitCode: result.then((value) => value.exitCode),
      kill,
      logs: () => logs.stream(),
      output: async () => {
        const value = await result;
        return { stderr: value.stderr, stdout: value.stdout };
      },
    };
  }

  async writeFile(
    path: string,
    data: string | Buffer,
    opts: { mode?: number } = {},
  ): Promise<void> {
    const content =
      typeof data === "string"
        ? data
        : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    await this.sandbox.files.write(path, content);
    if (opts.mode !== undefined) {
      const result = await this.sandbox.commands.run(
        `chmod ${shellQuote(opts.mode.toString(8))} ${shellQuote(path)}`,
      );
      if (result.exitCode !== 0) throw new Error(result.stderr || "Failed to set file mode.");
    }
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await this.sandbox.files.read(path);
    } catch (error) {
      if (error instanceof FileNotFoundError) return null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.sandbox.kill();
    } catch {
      // The sandbox may already have reached its timeout.
    }
  }
}

export async function createE2BSessionSandbox(
  input: CreateSessionSandboxInput,
  connection: E2BConnection,
): Promise<SandboxHandle> {
  const sandbox = await Sandbox.create({
    apiKey: connection.credentials.apiKey,
    envs: { CI: "1", GH_TOKEN: input.installationToken },
    lifecycle: { onTimeout: "kill" },
    metadata: {
      wallie_owner_id: input.ownerId ?? input.sessionId,
      wallie_session_id: input.sessionId,
      wallie_workspace_id: input.workspaceId ?? input.sessionId,
    },
    signal: input.signal,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const handle = new E2BSandboxHandle(sandbox);

  try {
    await input.onSandboxCreated?.({ provider: "e2b", sandboxId: handle.id });
    await prepareSessionSandbox({
      handle,
      provider: "e2b",
      repoAlreadyCloned: false,
      request: input,
    });
  } catch (error) {
    await handle.stop();
    throw error;
  }

  return handle;
}

export async function validateE2BConnection(connection: E2BConnection) {
  try {
    await Sandbox.list({ apiKey: connection.credentials.apiKey, limit: 1 }).nextItems();
    return { ok: true as const };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "E2B rejected the API key.",
      ok: false as const,
    };
  }
}

export async function listRunningE2BSandboxes(
  connection: E2BConnection,
  options: { workspaceId?: string } = {},
): Promise<RunningSandboxSummary[]> {
  const paginator = Sandbox.list({
    apiKey: connection.credentials.apiKey,
    query: {
      metadata: options.workspaceId ? { wallie_workspace_id: options.workspaceId } : undefined,
      state: ["running", "paused"],
    },
  });
  const result: RunningSandboxSummary[] = [];
  while (paginator.hasNext) {
    for (const sandbox of await paginator.nextItems()) {
      result.push({
        createdAt: sandbox.startedAt.getTime(),
        id: sandbox.sandboxId,
        status: sandbox.state,
      });
    }
  }
  return result;
}

export async function stopE2BSandboxById(
  sandboxId: string,
  connection: E2BConnection,
): Promise<void> {
  const sandbox = await Sandbox.connect(sandboxId, { apiKey: connection.credentials.apiKey });
  await sandbox.kill();
}

export const e2bSandboxDriver: SandboxProviderDriver<E2BConnection> = {
  create: createE2BSessionSandbox,
  listRunning: listRunningE2BSandboxes,
  stopById: stopE2BSandboxById,
  validate: validateE2BConnection,
};
