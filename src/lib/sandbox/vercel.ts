import { APIError, Sandbox } from "@vercel/sandbox";

import {
  formatVercelSandboxError,
  isVercelSandboxApiError,
  vercelSandboxFetch,
} from "@/lib/vercel-sandbox/errors";

import { finalizeSandboxAcquisition } from "./lifecycle";
import type {
  CreateSessionSandboxInput,
  CreateUtilitySandboxInput,
  RunningSandboxSummary,
  SandboxConnection,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxProviderDriver,
} from "./types";

const REPO_PATH = "/vercel/sandbox";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const TERMINAL_SOURCE_STATUSES = new Set(["stopped", "failed", "aborted"]);
type VercelConnection = Extract<SandboxConnection, { provider: "vercel" }>;
type VercelCredentials = VercelConnection["credentials"];

function vercelClientOptions(credentials: VercelCredentials) {
  return {
    fetch: vercelSandboxFetch,
    projectId: credentials.projectId,
    teamId: credentials.teamId,
    token: credentials.token,
  };
}

function rethrowVercelSandboxError(error: unknown, secrets: Array<string | undefined>): never {
  if (isVercelSandboxApiError(error)) {
    throw new Error(formatVercelSandboxError(error, secrets), { cause: error });
  }
  throw error;
}

/**
 * v2 reports a missing sandbox as 404 and an already-stopped session as 410.
 * Either one means the provider has nothing left to stop.
 */
function isConfirmedGone(error: unknown): boolean {
  return (
    error instanceof APIError && (error.response.status === 404 || error.response.status === 410)
  );
}

/**
 * Vercel Sandbox-backed implementation of `SandboxHandle`.
 *
 * Requires caller-supplied workspace Vercel credentials. Wallie session
 * sandboxes are billed to the workspace's connected Vercel project.
 */
class VercelSandboxHandle implements SandboxHandle {
  readonly repoPath = REPO_PATH;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly secrets: Array<string | undefined>,
  ) {}

  get id(): string {
    return this.sandbox.name;
  }

  async exec(
    cmd: string,
    args: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecHandle> {
    let command;
    try {
      command = await this.sandbox.runCommand({
        cmd,
        args,
        cwd: opts.cwd ?? REPO_PATH,
        env: opts.env,
        detached: true,
        signal: opts.signal,
      });
    } catch (error) {
      rethrowVercelSandboxError(error, this.secrets);
    }

    const secrets = this.secrets;
    const waitPromise = command.wait().then(
      (result) => result.exitCode,
      (error: unknown) => rethrowVercelSandboxError(error, secrets),
    );

    return {
      logs: () => ({
        async *[Symbol.asyncIterator]() {
          try {
            for await (const entry of command.logs()) {
              yield { data: entry.data, stream: entry.stream };
            }
          } catch (error) {
            rethrowVercelSandboxError(error, secrets);
          }
        },
      }),
      output: async () => {
        try {
          const [stdout, stderr] = await Promise.all([
            command.output("stdout"),
            command.output("stderr"),
          ]);
          return { stdout, stderr };
        } catch (error) {
          rethrowVercelSandboxError(error, secrets);
        }
      },
      exitCode: waitPromise,
      kill: async (signal) => {
        try {
          await command.kill(signal);
        } catch (error) {
          rethrowVercelSandboxError(error, secrets);
        }
      },
    };
  }

  async writeFile(
    path: string,
    data: string | Buffer,
    opts: { mode?: number } = {},
  ): Promise<void> {
    const content = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    try {
      await this.sandbox.writeFiles([{ path, content, mode: opts.mode }]);
    } catch (error) {
      rethrowVercelSandboxError(error, this.secrets);
    }
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const buf = await this.sandbox.readFileToBuffer({ path });
      return buf ? buf.toString("utf8") : null;
    } catch (error) {
      rethrowVercelSandboxError(error, this.secrets);
    }
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
 *
 * `runtime: "node22"` stays on the Amazon Linux image the setup script's dnf
 * bootstrap expects. SDK 3.x prefers `image`, and the Ubuntu node image would
 * change that bootstrap. `persistent: false` keeps the v1 ephemeral lifecycle:
 * stopping a sandbox drops its filesystem unless an explicit snapshot exists.
 */
export async function createVercelSessionSandbox(
  input: CreateSessionSandboxInput,
  connection: VercelConnection,
): Promise<SandboxHandle> {
  const mode = input.mode ?? { kind: "fresh-branch" as const };
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const revision = mode.kind === "checkout-pr" ? mode.prBranch : input.baseBranch;

  const credentials = connection.credentials;
  const secrets = [credentials.token, input.installationToken];

  const sandbox = await Sandbox.create({
    ...vercelClientOptions(credentials),
    source: {
      type: "git",
      url: `https://github.com/${input.repoFullName}.git`,
      username: "x-access-token",
      password: input.installationToken,
      revision,
      depth: 1,
    },
    runtime: "node22",
    timeout: timeoutMs,
    persistent: false,
    ...(input.signal ? { signal: input.signal } : {}),
    resources: { vcpus: 2 },
    env: {
      CI: "1",
      // Used by the setup script + any subsequent git op.
      GH_TOKEN: input.installationToken,
    },
  }).catch((error: unknown) => {
    rethrowVercelSandboxError(error, secrets);
  });

  const handle = new VercelSandboxHandle(sandbox, secrets);
  return finalizeSandboxAcquisition({
    handle,
    provider: "vercel",
    repoAlreadyCloned: true,
    request: input,
  });
}

/**
 * Best-effort stop of a sandbox by ID. Used by the stall sweep and the
 * sandbox reaper to terminate orphans whose owning run is no longer active.
 *
 * A sandbox that the provider confirms is gone is already cleaned up.
 * Other errors are logged by default and propagated in strict cleanup mode.
 */
export async function stopVercelSandboxById(
  sandboxId: string,
  connection: VercelConnection | VercelCredentials,
  options: { throwOnError?: boolean } = {},
): Promise<void> {
  const credentials = "credentials" in connection ? connection.credentials : connection;

  try {
    const sandbox = await Sandbox.get({
      ...vercelClientOptions(credentials),
      name: sandboxId,
    });
    await sandbox.stop();
  } catch (error) {
    if (isConfirmedGone(error)) return;

    const message = formatVercelSandboxError(error, [credentials.token]);
    if (options.throwOnError) {
      throw new Error(message, { cause: error });
    }
    console.error("[sandbox] failed to stop sandbox", {
      error: message,
      sandboxId,
    });
  }
}

async function eachVercelSandboxPage(
  credentials: VercelCredentials,
  visit: (sandbox: {
    createdAt: number;
    currentSnapshotId?: string;
    name: string;
    status: string;
  }) => boolean | void,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await Sandbox.list({
      ...vercelClientOptions(credentials),
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const sandbox of page.sandboxes) {
      if (visit(sandbox) === false) return;
    }
    cursor = page.pagination.next ?? undefined;
  } while (cursor);
}

/**
 * List sandboxes in the current Vercel project. Used by the reaper to find
 * orphans. Returns only sandboxes in active states (`pending` or `running`)
 * — terminal states do not need cleanup.
 */
export async function listRunningVercelSandboxes(
  connection: VercelConnection | VercelCredentials,
  options: { throwOnError?: boolean } = {},
): Promise<RunningSandboxSummary[]> {
  const credentials = "credentials" in connection ? connection.credentials : connection;

  try {
    const activeSandboxes: RunningSandboxSummary[] = [];
    await eachVercelSandboxPage(credentials, (sandbox) => {
      if (sandbox.status !== "pending" && sandbox.status !== "running") return;
      activeSandboxes.push({
        id: sandbox.name,
        status: sandbox.status,
        createdAt: sandbox.createdAt,
      });
    });
    return activeSandboxes;
  } catch (error) {
    const message = formatVercelSandboxError(error, [credentials.token]);
    if (options.throwOnError) {
      throw new Error(message, { cause: error });
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
      ...vercelClientOptions(connection.credentials),
      limit: 1,
    });
    return { ok: true as const };
  } catch (error) {
    return {
      error: formatVercelSandboxError(error, [connection.credentials.token]),
      ok: false as const,
    };
  }
}

export async function hasRecoverableVercelSandboxSource(
  sandboxId: string,
  connection: VercelConnection,
): Promise<boolean> {
  let recoverable = false;
  await eachVercelSandboxPage(connection.credentials, (sandbox) => {
    if (sandbox.name !== sandboxId) return;
    // Non-persistent sandboxes lose their filesystem once stopped, failed, or
    // aborted. An explicit snapshot, or any non-terminal status, still has source.
    recoverable =
      sandbox.currentSnapshotId !== undefined || !TERMINAL_SOURCE_STATUSES.has(sandbox.status);
    return false;
  });
  return recoverable;
}

export const vercelSandboxDriver: SandboxProviderDriver<VercelConnection> = {
  create: createVercelSessionSandbox,
  createUtility: async (input: CreateUtilitySandboxInput, connection) => {
    const secrets = [connection.credentials.token];
    const sandbox = await Sandbox.create({
      ...vercelClientOptions(connection.credentials),
      runtime: "node22",
      persistent: false,
      timeout: input.timeoutMs,
      resources: { vcpus: 2 },
      signal: input.signal,
    }).catch((error: unknown) => {
      rethrowVercelSandboxError(error, secrets);
    });
    const handle = new VercelSandboxHandle(sandbox, secrets);
    try {
      await input.onSandboxCreated({ provider: "vercel", sandboxId: handle.id });
      input.signal?.throwIfAborted();
      return handle;
    } catch (error) {
      await handle.stop();
      throw error;
    }
  },
  hasRecoverableSource: hasRecoverableVercelSandboxSource,
  listRunning: (connection, options) =>
    listRunningVercelSandboxes(connection, { throwOnError: true, ...options }),
  stopById: (sandboxId, connection) =>
    stopVercelSandboxById(sandboxId, connection, { throwOnError: true }),
  validate: validateVercelConnectionDriver,
};
