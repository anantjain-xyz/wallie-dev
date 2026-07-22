import type {
  CreateSessionSandboxInput,
  RunningSandboxSummary,
  SandboxConnection,
  SandboxHandle,
  SandboxImplementation,
  SandboxProvider,
  SandboxProviderDriver,
} from "./types";
import { redactSecrets } from "./command";

export type {
  AgentProvider,
  CreateSessionSandboxInput,
  DaytonaSandboxCredentials,
  E2BSandboxCredentials,
  RunningSandboxSummary,
  SandboxCheckoutMode,
  SandboxConnection,
  SandboxExecHandle,
  SandboxExecOptions,
  SandboxHandle,
  SandboxImplementation,
  SandboxLogEntry,
  SandboxProvider,
  SandboxProviderDriver,
  VercelSandboxCredentials,
} from "./types";
export { FakeSandbox } from "./fake";

const IMPLEMENTATIONS = ["vercel", "e2b", "daytona", "fake"] as const;
const DRIVER_LOADERS = {
  daytona: async () => (await import("./daytona")).daytonaSandboxDriver,
  e2b: async () => (await import("./e2b")).e2bSandboxDriver,
  vercel: async () => (await import("./vercel")).vercelSandboxDriver,
} satisfies Record<SandboxProvider, () => Promise<unknown>>;

async function loadProviderDriver<Connection extends SandboxConnection>(
  connection: Connection,
): Promise<SandboxProviderDriver<Connection>> {
  const driver = await DRIVER_LOADERS[connection.provider]();
  return driver as SandboxProviderDriver<Connection>;
}

export function resolveSandboxImplementation(
  override?: CreateSessionSandboxInput["implementation"],
): SandboxImplementation {
  const impl = override ?? process.env.WALLIE_SANDBOX_IMPL ?? "vercel";
  if (!IMPLEMENTATIONS.includes(impl as SandboxImplementation)) {
    throw new Error(
      `Unknown WALLIE_SANDBOX_IMPL: ${impl}. Expected ${IMPLEMENTATIONS.map((value) => `"${value}"`).join(", ")}.`,
    );
  }
  return impl as SandboxImplementation;
}

function resolveInputImplementation(input: CreateSessionSandboxInput): SandboxImplementation {
  const explicit = input.implementation ?? process.env.WALLIE_SANDBOX_IMPL;
  if (explicit === "fake") return "fake";
  if (input.connection) {
    if (explicit && explicit !== input.connection.provider) {
      throw new Error(
        `Sandbox implementation ${explicit} does not match the ${input.connection.provider} workspace connection.`,
      );
    }
    return input.connection.provider;
  }
  return resolveSandboxImplementation(input.implementation);
}

export async function createSessionSandbox(
  input: CreateSessionSandboxInput,
): Promise<SandboxHandle> {
  const implementation = resolveInputImplementation(input);
  if (implementation === "fake") {
    const { FakeSandbox } = await import("./fake");
    const sandbox = new FakeSandbox(undefined, {
      baseBranch: input.baseBranch,
      branch: input.branch,
      passthroughExec: true,
    });
    await input.onSandboxCreated?.({ provider: "fake", sandboxId: sandbox.id });
    return sandbox;
  }

  const connection = input.connection;
  if (!connection || connection.provider !== implementation) {
    throw new Error(`Workspace ${implementation} Sandbox connection is required.`);
  }

  try {
    return await (await loadProviderDriver(connection)).create(input, connection);
  } catch (error) {
    throw sanitizedSandboxError(error, connection, [input.installationToken]);
  }
}

export async function validateSandboxConnection(connection: SandboxConnection) {
  const result = await (await loadProviderDriver(connection)).validate(connection);
  return result.error
    ? { ...result, error: redactSecrets(result.error, connectionSecrets(connection)) }
    : result;
}

export async function stopSandboxById(
  sandboxId: string,
  options: {
    connection?: SandboxConnection;
    throwOnError?: boolean;
    /** @deprecated Compatibility input while callers migrate to `connection`. */
    vercelCredentials?: Extract<SandboxConnection, { provider: "vercel" }>["credentials"];
  } = {},
): Promise<void> {
  const connection =
    options.connection ??
    (options.vercelCredentials
      ? ({
          credentials: options.vercelCredentials,
          provider: "vercel",
          revision: "legacy",
        } satisfies SandboxConnection)
      : undefined);
  if (!connection) {
    if (resolveSandboxImplementation() === "fake") {
      const { stopFakeSandboxById } = await import("./fake");
      await stopFakeSandboxById(sandboxId);
      return;
    }
    if (options.throwOnError) throw new Error("Cannot stop sandbox without its connection.");
    console.error("[sandbox] cannot stop sandbox without its connection", { sandboxId });
    return;
  }

  try {
    await (await loadProviderDriver(connection)).stopById(sandboxId, connection);
  } catch (error) {
    if (options.throwOnError) throw error;
    console.error("[sandbox] failed to stop sandbox", {
      error: redactSecrets(
        error instanceof Error ? error.message : String(error),
        connectionSecrets(connection),
      ),
      provider: connection.provider,
      sandboxId,
    });
  }
}

export async function listRunningSandboxes(
  options: {
    connection?: SandboxConnection;
    throwOnError?: boolean;
    workspaceId?: string;
    /** @deprecated Compatibility input while callers migrate to `connection`. */
    vercelCredentials?: Extract<SandboxConnection, { provider: "vercel" }>["credentials"];
  } = {},
): Promise<RunningSandboxSummary[]> {
  const connection =
    options.connection ??
    (options.vercelCredentials
      ? ({
          credentials: options.vercelCredentials,
          provider: "vercel",
          revision: "legacy",
        } satisfies SandboxConnection)
      : undefined);
  if (!connection) {
    if (resolveSandboxImplementation() === "fake") {
      const { listRunningFakeSandboxes } = await import("./fake");
      return listRunningFakeSandboxes();
    }
    if (options.throwOnError) throw new Error("Cannot list sandboxes without a connection.");
    return [];
  }

  try {
    return await (
      await loadProviderDriver(connection)
    ).listRunning(connection, {
      workspaceId: options.workspaceId,
    });
  } catch (error) {
    if (options.throwOnError) throw error;
    console.error("[sandbox] failed to list sandboxes", {
      error: redactSecrets(
        error instanceof Error ? error.message : String(error),
        connectionSecrets(connection),
      ),
      provider: connection.provider,
    });
    return [];
  }
}

function connectionSecrets(connection: SandboxConnection): string[] {
  return connection.provider === "vercel"
    ? [connection.credentials.token]
    : [connection.credentials.apiKey];
}

function sanitizedSandboxError(
  error: unknown,
  connection: SandboxConnection,
  extraSecrets: string[] = [],
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = new Error(
    redactSecrets(message, [...connectionSecrets(connection), ...extraSecrets]),
  );
  sanitized.name = error instanceof Error ? error.name : "SandboxError";
  return sanitized;
}
