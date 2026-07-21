import { randomUUID } from "node:crypto";

import { Daytona, DaytonaNotFoundError } from "@daytona/sdk";

import { SandboxLogBuffer, shellEnvPrefix, shellJoin, shellQuote } from "./command";
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

const REPO_PATH = "/home/daytona/wallie/repo";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DAYTONA_CLOUD_API_URL = "https://app.daytona.io/api";

type DaytonaConnection = Extract<SandboxConnection, { provider: "daytona" }>;

function createClient(connection: DaytonaConnection): Daytona {
  return new Daytona({
    apiKey: connection.credentials.apiKey,
    apiUrl: connection.credentials.apiUrl ?? DAYTONA_CLOUD_API_URL,
    target: connection.credentials.target,
  });
}

class DaytonaSandboxHandle implements SandboxHandle {
  readonly repoPath = REPO_PATH;
  private stopped = false;

  constructor(
    private readonly client: Daytona,
    private readonly sandbox: Awaited<ReturnType<Daytona["create"]>>,
  ) {}

  get id(): string {
    return this.sandbox.id;
  }

  async exec(
    cmd: string,
    args: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecHandle> {
    const sessionId = `wallie-${randomUUID()}`;
    const logs = new SandboxLogBuffer();
    const cwd = opts.cwd ?? REPO_PATH;
    const command = `cd ${shellQuote(cwd)} && ${shellEnvPrefix(opts.env)}${shellJoin(cmd, args)}`;

    await this.sandbox.process.createSession(sessionId);
    let response: Awaited<ReturnType<typeof this.sandbox.process.executeSessionCommand>>;
    try {
      response = await this.sandbox.process.executeSessionCommand(sessionId, {
        command,
        runAsync: true,
        suppressInputEcho: true,
      });
    } catch (error) {
      await this.sandbox.process.deleteSession(sessionId).catch(() => undefined);
      throw error;
    }

    let killed = false;
    const result = this.sandbox.process
      .getSessionCommandLogs(
        sessionId,
        response.cmdId,
        (data) => logs.push({ data, stream: "stdout" }),
        (data) => logs.push({ data, stream: "stderr" }),
      )
      .then(async () => {
        const [commandInfo, output] = await Promise.all([
          this.sandbox.process.getSessionCommand(sessionId, response.cmdId),
          this.sandbox.process.getSessionCommandLogs(sessionId, response.cmdId),
        ]);
        return {
          exitCode: commandInfo.exitCode ?? (killed ? 137 : 1),
          stderr: output.stderr ?? "",
          stdout: output.stdout ?? "",
        };
      })
      .catch((error: unknown) => {
        if (killed) return { exitCode: 137, stderr: "", stdout: "" };
        throw error;
      })
      .finally(async () => {
        logs.close();
        await this.sandbox.process.deleteSession(sessionId).catch(() => undefined);
      });

    const kill = async () => {
      killed = true;
      await this.sandbox.process.deleteSession(sessionId).catch(() => undefined);
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
    const content = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await this.sandbox.fs.uploadFile(content, path);
    if (opts.mode !== undefined) {
      const result = await this.sandbox.process.executeCommand(
        `chmod ${shellQuote(opts.mode.toString(8))} ${shellQuote(path)}`,
      );
      if (result.exitCode !== 0) throw new Error(result.result || "Failed to set file mode.");
    }
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return (await this.sandbox.fs.downloadFile(path)).toString("utf8");
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      await this.sandbox.delete(60, true);
    } catch {
      // The sandbox may already have been destroyed by its TTL.
    } finally {
      await this.client[Symbol.asyncDispose]();
    }
  }
}

export async function createDaytonaSessionSandbox(
  input: CreateSessionSandboxInput,
  connection: DaytonaConnection,
): Promise<SandboxHandle> {
  const client = createClient(connection);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let sandbox: Awaited<ReturnType<Daytona["create"]>>;
  try {
    sandbox = await client.create(
      {
        autoStopInterval: 0,
        ephemeral: true,
        envVars: { CI: "1", GH_TOKEN: input.installationToken },
        image: "node:22-bookworm",
        labels: {
          wallie_owner_id: input.ownerId ?? input.sessionId,
          wallie_session_id: input.sessionId,
          wallie_workspace_id: input.workspaceId ?? input.sessionId,
        },
        resources: { cpu: 2, disk: 20, memory: 4 },
        ttlMinutes: Math.ceil(timeoutMs / 60_000) + 10,
      },
      { timeout: Math.max(60, Math.ceil(timeoutMs / 1000)) },
    );
  } catch (error) {
    await client[Symbol.asyncDispose]();
    throw error;
  }

  const handle = new DaytonaSandboxHandle(client, sandbox);
  try {
    await input.onSandboxCreated?.({ provider: "daytona", sandboxId: handle.id });
    await prepareSessionSandbox({
      handle,
      provider: "daytona",
      repoAlreadyCloned: false,
      request: input,
    });
  } catch (error) {
    await handle.stop();
    throw error;
  }
  return handle;
}

export async function validateDaytonaConnection(connection: DaytonaConnection) {
  const client = createClient(connection);
  try {
    const iterator = client.list({ limit: 1 });
    await iterator.next();
    return { ok: true as const };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Daytona rejected the connection.",
      ok: false as const,
    };
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

export async function listRunningDaytonaSandboxes(
  connection: DaytonaConnection,
  options: { workspaceId?: string } = {},
): Promise<RunningSandboxSummary[]> {
  const client = createClient(connection);
  try {
    const sandboxes: RunningSandboxSummary[] = [];
    for await (const sandbox of client.list({
      labels: options.workspaceId ? { wallie_workspace_id: options.workspaceId } : undefined,
      limit: 100,
    })) {
      const status = String(sandbox.state ?? "").toLowerCase();
      if (status !== "started" && status !== "starting" && status !== "pending") continue;
      sandboxes.push({
        createdAt: sandbox.createdAt ? Date.parse(sandbox.createdAt) : Date.now(),
        id: sandbox.id,
        status: status === "started" ? "running" : "pending",
      });
    }
    return sandboxes;
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

export async function stopDaytonaSandboxById(
  sandboxId: string,
  connection: DaytonaConnection,
): Promise<void> {
  const client = createClient(connection);
  try {
    const sandbox = await client.get(sandboxId);
    await client.delete(sandbox, 60, true);
  } catch (error) {
    if (!(error instanceof DaytonaNotFoundError)) throw error;
  } finally {
    await client[Symbol.asyncDispose]();
  }
}

export const daytonaSandboxDriver: SandboxProviderDriver<DaytonaConnection> = {
  create: createDaytonaSessionSandbox,
  listRunning: listRunningDaytonaSandboxes,
  stopById: stopDaytonaSandboxById,
  validate: validateDaytonaConnection,
};
