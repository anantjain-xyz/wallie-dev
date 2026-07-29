import type {
  CreateSessionSandboxInput,
  RunningSandboxSummary,
  SandboxConnection,
  SandboxHandle,
  SandboxImplementation,
  SandboxProviderDriver,
} from "./types";
import { redactSecrets } from "./command";
import { runBoundedSandboxProviderOperation, SandboxProviderDeadlineError } from "./lifecycle";
import {
  getSandboxProviderContract,
  loadSandboxProviderDriver,
  listSandboxProviders,
} from "./provider-contract";

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

const IMPLEMENTATIONS = [...listSandboxProviders(), "fake"] as const;

async function loadProviderDriver<Connection extends SandboxConnection>(
  connection: Connection,
): Promise<SandboxProviderDriver<Connection>> {
  return (await loadSandboxProviderDriver(
    connection.provider,
  )) as SandboxProviderDriver<Connection>;
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
    return await runBoundedSandboxProviderOperation({
      onLateSuccess: (handle) => handle.stop(),
      operation: "acquire",
      provider: connection.provider,
      run: async (signal) =>
        (await loadProviderDriver(connection)).create({ ...input, signal }, connection),
      signal: input.signal,
    });
  } catch (error) {
    throw sanitizedSandboxError(error, connection, [input.installationToken]);
  }
}

export async function validateSandboxConnection(connection: SandboxConnection) {
  try {
    const result = await runBoundedSandboxProviderOperation({
      operation: "validate",
      provider: connection.provider,
      run: async () => (await loadProviderDriver(connection)).validate(connection),
    });
    return result.error
      ? { ...result, error: redactSecrets(result.error, connectionSecrets(connection)) }
      : result;
  } catch (error) {
    if (error instanceof SandboxProviderDeadlineError) {
      return { error: error.message, ok: false as const };
    }
    throw error;
  }
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
    await runBoundedSandboxProviderOperation({
      operation: "stopById",
      provider: connection.provider,
      run: async () => (await loadProviderDriver(connection)).stopById(sandboxId, connection),
    });
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
    return await runBoundedSandboxProviderOperation({
      operation: "listRunning",
      provider: connection.provider,
      run: async () =>
        (await loadProviderDriver(connection)).listRunning(connection, {
          workspaceId: options.workspaceId,
        }),
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
  const secretFields = getSandboxProviderContract(connection.provider).credentials.secretFields;
  const credentials = connection.credentials as unknown as Record<string, unknown>;
  return secretFields.flatMap((field) =>
    typeof credentials[field] === "string" ? [credentials[field]] : [],
  );
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
