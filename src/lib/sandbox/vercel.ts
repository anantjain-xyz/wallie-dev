import { APIError, Sandbox, type Command, type NetworkPolicy } from "@vercel/sandbox";

import {
  formatVercelSandboxError,
  isVercelSandboxApiError,
  vercelSandboxErrorStatus,
  vercelSandboxFetch,
} from "@/lib/vercel-sandbox/errors";

import { sandboxAcquisitionLabels, sandboxAcquisitionName } from "./acquisition-identity";
import { finalizeSandboxAcquisition, observeUntilAbort } from "./lifecycle";
import type {
  CreateSessionSandboxInput,
  CreateUtilitySandboxInput,
  RunningSandboxSummary,
  SandboxAcquisitionIdentity,
  SandboxConnection,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxProviderDriver,
} from "./types";

const REPO_PATH = "/vercel/sandbox";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const TERMINAL_SOURCE_STATUSES = new Set(["stopped", "failed", "aborted"]);
/** Pause before re-issuing a wait whose gateway request failed. */
const WAIT_RETRY_DELAY_MS = 2_000;
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

function isRetryableWaitFailure(error: unknown): boolean {
  const status = vercelSandboxErrorStatus(error);
  return status !== undefined && status >= 500 && status <= 599;
}

function waitBeforeRetry(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, WAIT_RETRY_DELAY_MS));
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, WAIT_RETRY_DELAY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `Command.wait()` long-polls `GET /cmd/:id?wait=true` until the command
 * exits. The gateway in front of Vercel Sandbox eventually closes a request
 * it has held open with a non-JSON `524`, so a healthy agent run that outlives
 * the gateway budget would otherwise fail to report its exit code. A 5xx
 * describes the wait request, not the command, so retry the wait until the
 * command reports a result or the caller aborts.
 */
async function waitForVercelCommand(
  command: Command,
  secrets: Array<string | undefined>,
  signal?: AbortSignal,
): Promise<number> {
  for (;;) {
    try {
      const finished = await command.wait(signal ? { signal } : undefined);
      return finished.exitCode;
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
      if (!isRetryableWaitFailure(error)) rethrowVercelSandboxError(error, secrets);
      await waitBeforeRetry(signal);
    }
  }
}

/**
 * Vercel Sandbox-backed implementation of `SandboxHandle`.
 *
 * Requires caller-supplied workspace Vercel credentials. Wallie session
 * sandboxes are billed to the workspace's connected Vercel project.
 */
class VercelSandboxHandle implements SandboxHandle {
  readonly repoPath = REPO_PATH;
  readonly #sandbox: Sandbox;
  readonly #secrets: Array<string | undefined>;

  constructor(sandbox: Sandbox, secrets: Array<string | undefined>) {
    this.#sandbox = sandbox;
    this.#secrets = secrets;
  }

  get id(): string {
    return this.#sandbox.name;
  }

  async exec(
    cmd: string,
    args: string[],
    opts: SandboxExecOptions = {},
  ): Promise<SandboxExecHandle> {
    let command;
    try {
      command = await this.#sandbox.runCommand({
        cmd,
        args,
        cwd: opts.cwd ?? REPO_PATH,
        env: opts.env,
        detached: true,
        signal: opts.signal,
      });
    } catch (error) {
      rethrowVercelSandboxError(error, this.#secrets);
    }

    const secrets = this.#secrets;
    const waitPromise = waitForVercelCommand(command, secrets, opts.signal);
    // Callers drain logs before awaiting exitCode, so a cancellation or budget
    // rejection can land first. Handle it here as well; awaiting the original
    // promise still observes the error, but the worker no longer treats it as
    // an unhandled rejection and exits.
    void waitPromise.catch(() => undefined);

    return {
      logs: () => ({
        async *[Symbol.asyncIterator]() {
          try {
            for await (const entry of command.logs(
              opts.signal ? { signal: opts.signal } : undefined,
            )) {
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
      await this.#sandbox.writeFiles([{ path, content, mode: opts.mode }]);
    } catch (error) {
      rethrowVercelSandboxError(error, this.#secrets);
    }
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const buf = await this.#sandbox.readFileToBuffer({ path });
      return buf ? buf.toString("utf8") : null;
    } catch (error) {
      rethrowVercelSandboxError(error, this.#secrets);
    }
  }

  async stop(): Promise<void> {
    try {
      await this.#sandbox.stop();
    } catch {
      // Already stopped or network hiccup; stop() is supposed to be idempotent.
    }
  }
}

const benchmarkInferenceHost = "api.openai.com";

type QualifiedBenchmarkSandboxProfile = { image: string; proxyUrl: string };

function isBenchmarkInferencePolicy(policy: Sandbox["networkPolicy"], proxyUrl: string) {
  if (typeof policy !== "object" || policy.subnets?.allow?.length) return false;
  const { allow } = policy;
  if (Array.isArray(allow)) return allow.length === 1 && allow[0] === benchmarkInferenceHost;
  if (!allow || Object.keys(allow).length !== 1) return false;
  const rules = allow[benchmarkInferenceHost];
  if (!Array.isArray(rules)) return false;
  // Vercel can omit handling rules in the readback. The caller must still
  // prove proxy routing and deny behavior from inside the sandbox.
  if (!rules.length) return true;
  const rule = rules[0];
  return rules.length === 1 && rule?.forwardURL === proxyUrl && !rule.match;
}

class VercelBenchmarkReplaySandboxHandle extends VercelSandboxHandle {
  #phase: "bootstrap" | "sealing" | "sealed" | "inference" = "bootstrap";
  readonly #sandbox: Sandbox;

  constructor(
    sandbox: Sandbox,
    secrets: Array<string | undefined>,
    private readonly inferenceProxyUrl?: string,
  ) {
    super(sandbox, secrets);
    this.#sandbox = sandbox;
  }

  override async exec(cmd: string, args: string[], opts: SandboxExecOptions = {}) {
    if (this.#phase === "sealing") {
      throw new Error("The benchmark replay network seal has not been verified.");
    }
    if ((this.#phase === "sealed" || this.#phase === "inference") && opts.env !== undefined) {
      throw new Error("Benchmark replay commands cannot inject environment variables.");
    }
    return super.exec(cmd, args, opts);
  }

  async seal(signal: AbortSignal) {
    if (this.#phase !== "bootstrap") {
      throw new Error("A benchmark replay sandbox can only be sealed once.");
    }
    this.#phase = "sealing";
    try {
      await observeUntilAbort(signal, () =>
        this.#sandbox.update({ networkPolicy: "deny-all" }, { signal }),
      );
      if (
        this.#sandbox.networkPolicy !== "deny-all" ||
        this.#sandbox.currentSession().networkPolicy !== "deny-all"
      ) {
        throw new Error("Unexpected Vercel Sandbox network policy.");
      }
      this.#phase = "sealed";
    } catch {
      signal.throwIfAborted();
      throw new Error("The benchmark replay network seal has not been verified.");
    }
  }
  async sealBenchmarkInference(signal: AbortSignal) {
    const proxyUrl = this.inferenceProxyUrl;
    if (!proxyUrl) throw new Error("The benchmark inference proxy is unavailable.");
    if (this.#phase === "bootstrap") await this.seal(signal);
    if (this.#phase !== "sealed") {
      throw new Error("Benchmark inference requires a verified network seal.");
    }
    this.#phase = "sealing";
    const policy = {
      allow: { [benchmarkInferenceHost]: [{ forwardURL: proxyUrl }] },
    } satisfies NetworkPolicy;
    await observeUntilAbort(signal, () =>
      this.#sandbox.update({ networkPolicy: policy }, { signal }),
    );
    if (
      !isBenchmarkInferencePolicy(this.#sandbox.networkPolicy, proxyUrl) ||
      !isBenchmarkInferencePolicy(this.#sandbox.currentSession().networkPolicy, proxyUrl)
    ) {
      throw new Error("The benchmark inference network policy has not been verified.");
    }
    this.#phase = "inference";
  }
}

export async function sealVercelBenchmarkReplaySandbox(
  sandbox: SandboxHandle,
  signal: AbortSignal,
) {
  if (!(sandbox instanceof VercelBenchmarkReplaySandboxHandle)) {
    throw new Error("A Vercel benchmark replay sandbox is required to seal egress.");
  }
  await sandbox.seal(signal);
}

function isBenchmarkBootstrapPolicy(policy: Sandbox["networkPolicy"]) {
  return (
    typeof policy === "object" &&
    Array.isArray(policy.allow) &&
    policy.allow.length === 1 &&
    policy.allow[0] === "github.com" &&
    !policy.subnets?.allow?.length
  );
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
    ...(mode.kind === "checkpoint"
      ? {}
      : {
          source: {
            type: "git",
            url: `https://github.com/${input.repoFullName}.git`,
            username: "x-access-token",
            password: input.installationToken,
            revision,
            depth: 1,
          },
        }),
    runtime: "node22",
    timeout: timeoutMs,
    persistent: false,
    ...(input.acquisition
      ? {
          name: sandboxAcquisitionName(input.acquisition),
          tags: sandboxAcquisitionLabels(input.acquisition),
        }
      : {}),
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
    repoAlreadyCloned: mode.kind !== "checkpoint",
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

async function findVercelAcquisition(
  identity: SandboxAcquisitionIdentity,
  connection: VercelConnection,
) {
  const name = sandboxAcquisitionName(identity);
  const page = await Sandbox.list({
    ...vercelClientOptions(connection.credentials),
    limit: 10,
    namePrefix: name,
  });
  if (page.pagination.next)
    throw new Error("Sandbox acquisition lookup exceeded its result limit.");
  const exact = page.sandboxes.find((sandbox) => sandbox.name === name);
  if (!exact) return [];
  if (
    exact.persistent ||
    exact.tags?.wallie_workspace_id !== identity.workspaceId ||
    exact.tags?.wallie_acquisition_id !== identity.operationId
  ) {
    throw new Error("Sandbox acquisition lookup returned a different owner.");
  }
  if (TERMINAL_SOURCE_STATUSES.has(exact.status) && !exact.currentSnapshotId) return [];
  return [exact.name];
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
      limit: 50,
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

async function createVercelUtilitySandbox(
  input: CreateUtilitySandboxInput,
  connection: VercelConnection,
  purpose: "utility" | "benchmark-replay",
  profile?: QualifiedBenchmarkSandboxProfile,
): Promise<SandboxHandle> {
  const benchmarkReplay = purpose === "benchmark-replay";
  const secrets = [connection.credentials.token];
  const sandbox = await Sandbox.create({
    ...vercelClientOptions(connection.credentials),
    ...(profile ? { image: profile.image } : { runtime: "node22" }),
    persistent: false,
    timeout: input.timeoutMs,
    resources: { vcpus: 2 },
    signal: input.signal,
    ...(benchmarkReplay ? { networkPolicy: { allow: ["github.com"] } } : {}),
    ...(input.acquisition
      ? {
          name: sandboxAcquisitionName(input.acquisition),
          tags: sandboxAcquisitionLabels(input.acquisition),
        }
      : {}),
  }).catch((error: unknown) => {
    rethrowVercelSandboxError(error, secrets);
  });
  const handle = benchmarkReplay
    ? new VercelBenchmarkReplaySandboxHandle(sandbox, secrets, profile?.proxyUrl)
    : new VercelSandboxHandle(sandbox, secrets);
  try {
    await input.onSandboxCreated({ provider: "vercel", sandboxId: handle.id });
    input.signal?.throwIfAborted();
    if (
      benchmarkReplay &&
      (!isBenchmarkBootstrapPolicy(sandbox.networkPolicy) ||
        !isBenchmarkBootstrapPolicy(sandbox.currentSession().networkPolicy))
    ) {
      throw new Error("The benchmark replay bootstrap network policy has not been verified.");
    }
    return handle;
  } catch (error) {
    await handle.stop();
    throw error;
  }
}

export function createVercelBenchmarkReplaySandbox(
  input: CreateUtilitySandboxInput,
  connection: VercelConnection,
) {
  return createVercelUtilitySandbox(input, connection, "benchmark-replay");
}

export async function createVercelQualifiedBenchmarkReplaySandbox(
  input: CreateUtilitySandboxInput,
  connection: VercelConnection,
  profile: QualifiedBenchmarkSandboxProfile,
): Promise<SandboxHandle & { sealBenchmarkInference(signal: AbortSignal): Promise<void> }> {
  const proxy = new URL(profile.proxyUrl);
  if (
    !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(profile.image) ||
    proxy.protocol !== "https:" ||
    proxy.username ||
    proxy.password ||
    proxy.search ||
    proxy.hash
  ) {
    throw new Error("The benchmark inference profile is invalid.");
  }
  const sandbox = await createVercelUtilitySandbox(input, connection, "benchmark-replay", {
    image: profile.image,
    proxyUrl: proxy.href,
  });
  if (!(sandbox instanceof VercelBenchmarkReplaySandboxHandle)) {
    await sandbox.stop();
    throw new Error("The benchmark inference sandbox is unavailable.");
  }
  return sandbox;
}

export const vercelSandboxDriver: SandboxProviderDriver<VercelConnection> = {
  create: createVercelSessionSandbox,
  createUtility: (input, connection) => createVercelUtilitySandbox(input, connection, "utility"),
  findAcquisition: findVercelAcquisition,
  hasRecoverableSource: hasRecoverableVercelSandboxSource,
  listRunning: (connection, options) =>
    listRunningVercelSandboxes(connection, { throwOnError: true, ...options }),
  stopById: (sandboxId, connection) =>
    stopVercelSandboxById(sandboxId, connection, { throwOnError: true }),
  validate: validateVercelConnectionDriver,
};
