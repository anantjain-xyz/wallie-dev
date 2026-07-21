import { Sandbox } from "@vercel/sandbox";

import { redactSecrets } from "./command";
import { prepareSessionSandbox } from "./setup";
import type {
  CreateSessionSandboxInput,
  RunningSandboxSummary,
  SandboxConnection,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxLogEntry,
  SandboxProviderDriver,
} from "./types";

const REPO_PATH = "/vercel/sandbox";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
type VercelConnection = Extract<SandboxConnection, { provider: "vercel" }>;

/**
 * Vercel Sandbox-backed implementation of `SandboxHandle`.
 *
 * Requires caller-supplied workspace Vercel credentials. Wallie session
 * sandboxes are billed to the workspace's connected Vercel project.
 */
class VercelSandboxHandle implements SandboxHandle {
  readonly repoPath = REPO_PATH;

  constructor(private readonly sandbox: Sandbox) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  async exec(
    cmd: string,
    args: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecHandle> {
    const command = await this.sandbox.runCommand({
      cmd,
      args,
      cwd: opts.cwd ?? REPO_PATH,
      env: opts.env,
      detached: true,
      signal: opts.signal,
    });

    const waitPromise = command.wait().then((r) => r.exitCode);

    return {
      logs: () => command.logs() as AsyncIterable<SandboxLogEntry>,
      output: async () => {
        const [stdout, stderr] = await Promise.all([
          command.output("stdout"),
          command.output("stderr"),
        ]);
        return { stdout, stderr };
      },
      exitCode: waitPromise,
      kill: async (signal) => {
        await command.kill(signal);
      },
    };
  }

  async writeFile(
    path: string,
    data: string | Buffer,
    opts: { mode?: number } = {},
  ): Promise<void> {
    const content = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    await this.sandbox.writeFiles([{ path, content, mode: opts.mode }]);
  }

  async readFile(path: string): Promise<string | null> {
    const buf = await this.sandbox.readFileToBuffer({ path });
    return buf ? buf.toString("utf8") : null;
  }

  async stop(): Promise<void> {
    try {
      await this.sandbox.stop();
    } catch {
      // Already stopped or network hiccup; stop() is supposed to be idempotent.
    }
  }
}

/**
 * Boot a Vercel Sandbox for a session: clone the repo with the GH App token,
 * check out the working branch and install the chosen agent CLI. Provider
 * credentials are injected by the runner only for the process that needs them.
 */
export async function createVercelSessionSandbox(
  input: CreateSessionSandboxInput,
  connection: VercelConnection,
): Promise<SandboxHandle> {
  const mode = input.mode ?? { kind: "fresh-branch" as const };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const revision = mode.kind === "checkout-pr" ? mode.prBranch : input.baseBranch;

  const credentials = connection.credentials;

  const sandbox = await Sandbox.create({
    projectId: credentials.projectId,
    source: {
      type: "git",
      url: `https://github.com/${input.repoFullName}.git`,
      username: "x-access-token",
      password: input.installationToken,
      revision,
      depth: 1,
    },
    runtime: "node22",
    teamId: credentials.teamId,
    timeout: timeoutMs,
    token: credentials.token,
    resources: { vcpus: 2 },
    env: {
      CI: "1",
      // Used by the setup script + any subsequent git op.
      GH_TOKEN: input.installationToken,
    },
  });

  const handle = new VercelSandboxHandle(sandbox);

  try {
    await input.onSandboxCreated?.({ provider: "vercel", sandboxId: handle.id });
    await prepareSessionSandbox({
      handle,
      provider: "vercel",
      repoAlreadyCloned: true,
      request: input,
    });
  } catch (err) {
    await handle.stop();
    throw err;
  }

  return handle;
}

/**
 * Best-effort stop of a sandbox by ID. Used by the stall sweep and the
 * sandbox reaper to terminate orphans whose owning run is no longer active.
 *
 * Errors are swallowed: the sandbox may already be stopped, the ID may be
 * stale, or the network may be flaky. Stop is supposed to be idempotent;
 * losing one cleanup is far better than crashing the sweep timer.
 */
export async function stopVercelSandboxById(
  sandboxId: string,
  connection: VercelConnection | VercelConnection["credentials"],
  options: { throwOnError?: boolean } = {},
): Promise<void> {
  const credentials = "credentials" in connection ? connection.credentials : connection;

  try {
    const sandbox = await Sandbox.get({
      projectId: credentials.projectId,
      sandboxId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
    await sandbox.stop();
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), [
      credentials.token,
    ]);
    if (options.throwOnError) {
      throw new Error(message);
    }
    console.error("[sandbox] failed to stop sandbox", {
      error: message,
      sandboxId,
    });
  }
}

/**
 * List sandboxes in the current Vercel project. Used by the reaper to find
 * orphans. Returns only sandboxes in active states (`pending` or `running`)
 * — terminal states do not need cleanup.
 */
export async function listRunningVercelSandboxes(
  connection: VercelConnection | VercelConnection["credentials"],
  options: { throwOnError?: boolean } = {},
): Promise<RunningSandboxSummary[]> {
  const credentials = "credentials" in connection ? connection.credentials : connection;

  try {
    const activeSandboxes: RunningSandboxSummary[] = [];
    let until: number | null = null;

    do {
      const result = await Sandbox.list({
        projectId: credentials.projectId,
        teamId: credentials.teamId,
        token: credentials.token,
        limit: 100,
        ...(until === null ? {} : { until }),
      });

      for (const sandbox of result.json.sandboxes) {
        if (sandbox.status !== "pending" && sandbox.status !== "running") {
          continue;
        }
        activeSandboxes.push({
          id: sandbox.id,
          status: sandbox.status,
          createdAt: sandbox.createdAt,
        });
      }

      until = result.json.pagination.next;
    } while (until !== null);

    return activeSandboxes;
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), [
      credentials.token,
    ]);
    if (options.throwOnError) {
      throw new Error(message);
    }
    console.error("[sandbox] failed to list sandboxes", {
      error: message,
    });
    return [];
  }
}

export async function validateVercelConnectionDriver(connection: VercelConnection) {
  try {
    await Sandbox.list({
      limit: 1,
      projectId: connection.credentials.projectId,
      teamId: connection.credentials.teamId,
      token: connection.credentials.token,
    });
    return { ok: true as const };
  } catch (error) {
    return {
      error: redactSecrets(
        error instanceof Error ? error.message : "Vercel rejected the connection.",
        [connection.credentials.token],
      ),
      ok: false as const,
    };
  }
}

export const vercelSandboxDriver: SandboxProviderDriver<VercelConnection> = {
  create: createVercelSessionSandbox,
  listRunning: (connection, options) =>
    listRunningVercelSandboxes(connection, { throwOnError: true, ...options }),
  stopById: (sandboxId, connection) =>
    stopVercelSandboxById(sandboxId, connection, { throwOnError: true }),
  validate: validateVercelConnectionDriver,
};
