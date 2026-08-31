import "server-only";

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Daytona, DaytonaNotFoundError } from "@daytona/sdk";
import { FileNotFoundError as E2BFileNotFoundError, Sandbox as E2BSandbox } from "e2b";
import { Sandbox } from "@vercel/sandbox";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseCodexChatGptAuthJson } from "@/lib/codex/auth-json";
import type { CodexAuthJsonMetadata } from "@/lib/codex/contracts";
import { loadWorkspaceSandboxConnection } from "@/lib/sandbox-connections/server";
import type { SandboxConnection, SandboxProvider } from "@/lib/sandbox/types";
import { encryptSecretValue, decryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import type { VercelSandboxCredentials } from "@/lib/vercel-sandbox/contracts";

const FLOW_TTL_MS = 10 * 60_000;
const PROMPT_WAIT_MS = 2_500;
const POLL_WAIT_MS = 750;
const COMMAND_STATUS_WAIT_MS = 500;
const MAX_OUTPUT_CHARS = 4_000;
const VERCEL_CODEX_HOME = "/vercel/sandbox/.codex";
const VERCEL_SANDBOX_CWD = "/vercel/sandbox";
const E2B_CODEX_HOME = "/home/user/.codex";
const E2B_SANDBOX_CWD = "/home/user";
const DAYTONA_CODEX_HOME = "/home/daytona/.codex";
const DAYTONA_SANDBOX_CWD = "/home/daytona";
const DAYTONA_CLOUD_API_URL = "https://app.daytona.io/api";
const LOCAL_SANDBOX_PREFIX = "local:";
const CHATGPT_CODEX_PAYMENT_REQUIRED_MESSAGE =
  "OpenAI rejected the ChatGPT Codex sign-in with 402 Payment Required. Use a ChatGPT account with Codex access, or connect a Codex access token or OpenAI API key instead.";
const SANDBOX_PAYMENT_REQUIRED_MESSAGE =
  "Wallie could not use the Codex sign-in sandbox because the active sandbox provider returned 402 Payment Required. Check its billing and credentials, or connect Codex with a Codex access token or OpenAI API key for now.";
const USER_CODE_PATTERN = "[A-Z0-9]{4,}(?:[- ][A-Z0-9]{4,})*";
const USER_CODE_STOP_WORDS = new Set([
  "ABOVE",
  "ACTIVATE",
  "AUTHENTICATION",
  "AUTHORIZATION",
  "AUTHORIZE",
  "BELOW",
  "BROWSER",
  "CHATGPT",
  "CODE",
  "CONTINUE",
  "CREDENTIAL",
  "CREDENTIALS",
  "DEVICE",
  "DISPLAYED",
  "HERE",
  "LINK",
  "LOGIN",
  "OPEN",
  "OPENAI",
  "PERMISSION",
  "PERMISSIONS",
  "SHOWN",
  "SIGN",
  "SIGNIN",
  "SUBSCRIPTION",
  "TOKEN",
  "URL",
  "USER",
  "VISIT",
]);

export type CodexDeviceAuthStatus =
  | "starting"
  | "prompted"
  | "authenticated"
  | "canceled"
  | "error"
  | "expired";

export interface CodexDeviceAuthSnapshot {
  error: string | null;
  expiresAt: string;
  flowId: string;
  instructions: string | null;
  status: CodexDeviceAuthStatus;
  userCode: string | null;
  verificationUri: string | null;
}

type AdminClient = SupabaseClient<Database>;
type FlowRow = Database["public"]["Tables"]["codex_device_auth_flows"]["Row"];
type AuthCommandLog = { data: string };

interface AuthCommand {
  readonly exitCode: number | null;
  readonly outputIsSnapshot?: boolean;
  logs(input?: { signal?: AbortSignal }): AsyncIterable<AuthCommandLog>;
  output(stream: "both"): Promise<string>;
  wait?(input?: { signal?: AbortSignal }): Promise<AuthCommand>;
}

interface StartedAuthCommand extends AuthCommand {
  readonly cmdId: string;
}

interface AuthSandbox {
  readonly sandboxId: string;
  close?(): Promise<void>;
  getCommand(commandId: string): Promise<AuthCommand>;
  readFileToBuffer(input: { path: string }): Promise<Buffer | null>;
  runCommand(input: {
    args: string[];
    cmd: string;
    cwd: string;
    detached: boolean;
    env: Record<string, string>;
  }): Promise<StartedAuthCommand>;
  stop(): Promise<void>;
}

interface AuthSandboxSession {
  codexHome: string;
  cwd: string;
  installCodex: boolean;
  sandbox: AuthSandbox;
}

const ACTIVE_FLOW_STATUSES: CodexDeviceAuthStatus[] = ["starting", "prompted", "authenticated"];
const CANCELABLE_FLOW_STATUSES: CodexDeviceAuthStatus[] = ["starting", "prompted"];
const FLOW_SELECT =
  "id, user_id, workspace_id, status, sandbox_id, sandbox_provider, sandbox_connection_revision, command_id, verification_uri, user_code, instructions, error, encrypted_auth_json, account_id, account_email, auth_cache_last_refresh, output_tail, expires_at, completed_at, canceled_at, created_at, updated_at";

const localSandboxes = new Map<string, LocalAuthSandbox>();

export async function startCodexDeviceAuthFlow(input: {
  connection?: SandboxConnection;
  userId: string;
  vercelCredentials?: VercelSandboxCredentials;
  workspaceId?: string;
}): Promise<CodexDeviceAuthSnapshot> {
  const admin = createSupabaseAdminClient();
  const connection = connectionFromInput(input);
  await expireStaleUserFlows(admin, input.userId);
  const completedFlow = await cancelActiveUserFlows(admin, input.userId);
  if (completedFlow) return completedFlow;

  const flowId = randomUUID();
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS).toISOString();
  let flowRow: FlowRow | null = null;
  let sandbox: AuthSandbox | null = null;

  try {
    flowRow = await reserveCodexDeviceAuthFlow(admin, {
      connection,
      expiresAt,
      flowId,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    const session = await createAuthSandbox(connection, {
      flowId,
      userId: input.userId,
      workspaceId: input.workspaceId,
    });
    sandbox = session.sandbox;
    const command = await sandbox.runCommand({
      args: ["-lc", codexDeviceLoginCommand(session)],
      cmd: "bash",
      cwd: session.cwd,
      detached: true,
      env: { CI: "1", CODEX_HOME: session.codexHome },
    });
    const provisionedRow = await updateFlow(admin, flowRow, {
      command_id: command.cmdId,
      sandbox_id: sandbox.sandboxId,
    });
    if (
      !provisionedRow ||
      provisionedRow.status !== "starting" ||
      provisionedRow.sandbox_id !== sandbox.sandboxId ||
      provisionedRow.command_id !== command.cmdId
    ) {
      throw new Error("Codex sign-in reservation was lost during provisioning.");
    }
    flowRow = provisionedRow;
    await sandbox.close?.();

    return (
      (await refreshFlowFromSandbox(admin, flowRow, {
        connection,
        waitMs: PROMPT_WAIT_MS,
      })) ?? snapshotFromRow(flowRow)
    );
  } catch (error) {
    const message = startAuthErrorMessage(error);
    if (sandbox) {
      await stopSandboxQuietly(sandbox.sandboxId, connection);
    }
    if (flowRow) {
      const failedRow = await markFlowTerminal(admin, flowRow, {
        encrypted_auth_json: null,
        error: message,
        status: "error",
      }).catch(() => null);
      if (failedRow) return snapshotFromRow(failedRow);
    }

    return {
      error: message,
      expiresAt,
      flowId,
      instructions: null,
      status: "error",
      userCode: null,
      verificationUri: null,
    };
  }
}

async function reserveCodexDeviceAuthFlow(
  admin: AdminClient,
  input: {
    connection?: SandboxConnection;
    expiresAt: string;
    flowId: string;
    userId: string;
    workspaceId?: string;
  },
): Promise<FlowRow> {
  if (input.connection && input.workspaceId) {
    const { data, error } = await admin.rpc("begin_codex_device_auth_flow", {
      flow_id: input.flowId,
      target_connection_revision: input.connection.revision,
      target_expires_at: input.expiresAt,
      target_provider: input.connection.provider,
      target_user_id: input.userId,
      target_workspace_id: input.workspaceId,
    });
    if (error) throw error;
    if (data !== "started") {
      throw new Error(codexAuthReservationError(data, input.connection.provider));
    }
    const row = await getFlowRow(admin, { flowId: input.flowId, userId: input.userId });
    if (!row) throw new Error("Codex sign-in reservation could not be loaded.");
    return row;
  }

  const { data, error } = await admin
    .from("codex_device_auth_flows")
    .insert({
      command_id: "provisioning",
      expires_at: input.expiresAt,
      id: input.flowId,
      sandbox_connection_revision: input.connection?.revision ?? null,
      sandbox_id: `provisioning:${input.flowId}`,
      sandbox_provider: input.connection?.provider ?? null,
      status: "starting",
      user_id: input.userId,
      workspace_id: input.workspaceId ?? null,
    })
    .select(FLOW_SELECT)
    .single();
  if (error) throw error;
  return data;
}

function codexAuthReservationError(status: string | null, provider: SandboxProvider): string {
  if (status === "locked") {
    return `${providerLabel(provider)} connection update is already in progress. Try again shortly.`;
  }
  if (status === "inactive") {
    return `${providerLabel(provider)} is no longer the active sandbox provider. Refresh and try again.`;
  }
  if (status === "missing" || status === "invalid" || status === "stale") {
    return `${providerLabel(provider)} connection changed before Codex sign-in started. Refresh and try again.`;
  }
  return "Codex sign-in could not reserve the active sandbox connection.";
}

export async function getCodexDeviceAuthFlowSnapshot(input: {
  connection?: SandboxConnection;
  flowId: string;
  userId: string;
  vercelCredentials?: VercelSandboxCredentials;
}): Promise<CodexDeviceAuthSnapshot | null> {
  const admin = createSupabaseAdminClient();
  const row = await getFlowRow(admin, input);
  if (!row) return null;
  return refreshFlowFromSandbox(admin, row, {
    connection: connectionFromInput(input),
    waitMs: POLL_WAIT_MS,
  });
}

export async function consumeAuthenticatedCodexDeviceAuthFlow(input: {
  flowId: string;
  userId: string;
}): Promise<{
  authJson: string;
  metadata: CodexAuthJsonMetadata;
  snapshot: CodexDeviceAuthSnapshot;
} | null> {
  const admin = createSupabaseAdminClient();
  const row = await getFlowRow(admin, input);
  if (!row || row.status !== "authenticated" || !row.encrypted_auth_json) {
    return null;
  }

  const authJson = decryptSecretValue(row.encrypted_auth_json);
  const metadata = {
    accountEmail: row.account_email,
    accountId: row.account_id,
    lastRefresh: row.auth_cache_last_refresh,
  };

  return {
    authJson,
    metadata,
    snapshot: snapshotFromRow(row),
  };
}

export async function deleteCodexDeviceAuthFlow(input: {
  connection?: SandboxConnection;
  flowId: string;
  userId: string;
  vercelCredentials?: VercelSandboxCredentials;
}): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  const row = await getFlowRow(admin, input);
  if (!row) return false;

  const { error } = await admin
    .from("codex_device_auth_flows")
    .delete()
    .eq("id", row.id)
    .eq("user_id", input.userId);
  if (error) throw error;

  const connection = await resolveFlowConnection(admin, row, connectionFromInput(input));
  await stopSandboxQuietly(row.sandbox_id, connection);
  return true;
}

export async function cancelCodexDeviceAuthFlow(input: {
  connection?: SandboxConnection;
  flowId: string;
  userId: string;
  vercelCredentials?: VercelSandboxCredentials;
}): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  const row = await getFlowRow(admin, input);
  if (!row) return false;
  const connection = await resolveFlowConnection(admin, row, connectionFromInput(input));

  if (CANCELABLE_FLOW_STATUSES.includes(row.status as CodexDeviceAuthStatus)) {
    const refreshed = await refreshFlowFromSandbox(admin, row, {
      connection,
      waitMs: POLL_WAIT_MS,
    });
    if (refreshed.status !== "starting" && refreshed.status !== "prompted") {
      return true;
    }
  }

  const cancellableRow = await getFlowRow(admin, input);
  if (
    !cancellableRow ||
    !CANCELABLE_FLOW_STATUSES.includes(cancellableRow.status as CodexDeviceAuthStatus)
  ) {
    return false;
  }

  await markFlowTerminal(admin, cancellableRow, {
    canceled_at: new Date().toISOString(),
    encrypted_auth_json: null,
    error: null,
    status: "canceled",
  });
  await stopSandboxQuietly(cancellableRow.sandbox_id, connection);
  return true;
}

async function refreshFlowFromSandbox(
  admin: AdminClient,
  row: FlowRow,
  input: { connection?: SandboxConnection; waitMs: number },
): Promise<CodexDeviceAuthSnapshot> {
  const isExpired = new Date(row.expires_at).getTime() <= Date.now();
  if (row.status === "authenticated") {
    return isExpired ? expireFlow(admin, row, input.connection) : snapshotFromRow(row);
  }

  if (row.status === "canceled" || row.status === "error" || row.status === "expired") {
    return snapshotFromRow(row);
  }

  let connection = input.connection;
  let sandbox: AuthSandbox | null = null;
  try {
    connection = await resolveFlowConnection(admin, row, connection);
    sandbox = await getAuthSandbox(row.sandbox_id, connection);
    const command = await sandbox.getCommand(row.command_id);
    const commandOutput = await readCommandOutput(command, input.waitMs);
    const output = limitOutput(
      command.outputIsSnapshot ? commandOutput : `${row.output_tail ?? ""}${commandOutput}`,
    );
    const prompt = parseDevicePrompt(output);

    const refreshedCommand = await waitForCommandExit(command);
    if (refreshedCommand.exitCode === null) {
      if (isExpired) {
        return expireFlow(admin, row, connection);
      }

      const updated = await updateFlow(admin, row, {
        instructions: prompt.instructions ?? row.instructions,
        output_tail: output,
        status: prompt.hasPrompt ? "prompted" : row.status,
        user_code: prompt.userCode ?? row.user_code,
        verification_uri: prompt.verificationUri ?? row.verification_uri,
      });
      return snapshotFromRow(updated ?? row);
    }

    const finalOutput = await readFinishedCommandOutput(refreshedCommand, output);
    if (refreshedCommand.exitCode !== 0) {
      const updated = await markFlowTerminal(admin, row, {
        encrypted_auth_json: null,
        error: commandFailureMessage(finalOutput, refreshedCommand.exitCode),
        output_tail: finalOutput,
        status: "error",
      });
      await stopSandboxQuietly(row.sandbox_id, connection);
      return snapshotFromRow(updated ?? row);
    }

    const authJsonBuffer = await sandbox.readFileToBuffer({
      path: codexAuthFileForProvider(row.sandbox_provider),
    });
    if (!authJsonBuffer) {
      const updated = await markFlowTerminal(admin, row, {
        encrypted_auth_json: null,
        error: "Codex login completed without a valid auth cache.",
        output_tail: finalOutput,
        status: "error",
      });
      await stopSandboxQuietly(row.sandbox_id, connection);
      return snapshotFromRow(updated ?? row);
    }

    const authJson = authJsonBuffer.toString("utf8");
    const metadata = parseCodexChatGptAuthJson(authJson);
    const updated = await markFlowTerminal(admin, row, {
      account_email: metadata.accountEmail,
      account_id: metadata.accountId,
      auth_cache_last_refresh: metadata.lastRefresh,
      completed_at: new Date().toISOString(),
      encrypted_auth_json: encryptSecretValue(authJson),
      error: null,
      instructions: prompt.instructions ?? row.instructions,
      output_tail: null,
      status: "authenticated",
      user_code: prompt.userCode ?? row.user_code,
      verification_uri: prompt.verificationUri ?? row.verification_uri,
    });
    await stopSandboxQuietly(row.sandbox_id, connection);
    return snapshotFromRow(updated ?? row);
  } catch (error) {
    if (isExpired) {
      return expireFlow(admin, row, connection);
    }

    const updated = await markFlowTerminal(admin, row, {
      encrypted_auth_json: null,
      error: pollAuthErrorMessage(error),
      status: "error",
    });
    await stopSandboxQuietly(row.sandbox_id, connection);
    return snapshotFromRow(updated ?? row);
  } finally {
    await sandbox?.close?.().catch(() => undefined);
  }
}

async function getFlowRow(
  admin: AdminClient,
  input: { flowId: string; userId: string },
): Promise<FlowRow | null> {
  const { data, error } = await admin
    .from("codex_device_auth_flows")
    .select(FLOW_SELECT)
    .eq("id", input.flowId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function expireStaleUserFlows(admin: AdminClient, userId: string): Promise<void> {
  const { data, error } = await admin
    .from("codex_device_auth_flows")
    .select(FLOW_SELECT)
    .eq("user_id", userId)
    .in("status", ACTIVE_FLOW_STATUSES)
    .lte("expires_at", new Date().toISOString());
  if (error) throw error;

  for (const row of data ?? []) {
    await refreshFlowFromSandbox(admin, row, {
      connection: undefined,
      waitMs: COMMAND_STATUS_WAIT_MS,
    });
  }
}

async function cancelActiveUserFlows(
  admin: AdminClient,
  userId: string,
): Promise<CodexDeviceAuthSnapshot | null> {
  const { data, error } = await admin
    .from("codex_device_auth_flows")
    .select(FLOW_SELECT)
    .eq("user_id", userId)
    .in("status", CANCELABLE_FLOW_STATUSES);
  if (error) throw error;

  for (const row of data ?? []) {
    const refreshed = await refreshFlowFromSandbox(admin, row, {
      connection: undefined,
      waitMs: COMMAND_STATUS_WAIT_MS,
    });
    if (refreshed.status === "authenticated") {
      return refreshed;
    }
    if (!CANCELABLE_FLOW_STATUSES.includes(refreshed.status)) {
      continue;
    }

    const cancellableRow = await getFlowRow(admin, { flowId: row.id, userId: row.user_id });
    if (
      !cancellableRow ||
      !CANCELABLE_FLOW_STATUSES.includes(cancellableRow.status as CodexDeviceAuthStatus)
    ) {
      continue;
    }

    await markFlowTerminal(admin, cancellableRow, {
      canceled_at: new Date().toISOString(),
      encrypted_auth_json: null,
      error: null,
      status: "canceled",
    });
    const connection = await resolveFlowConnection(admin, cancellableRow);
    await stopSandboxQuietly(cancellableRow.sandbox_id, connection);
  }

  return null;
}

async function expireFlow(
  admin: AdminClient,
  row: FlowRow,
  connection?: SandboxConnection,
): Promise<CodexDeviceAuthSnapshot> {
  const updated = await markFlowTerminal(admin, row, {
    encrypted_auth_json: null,
    error: null,
    status: "expired",
  });
  const resolvedConnection = await resolveFlowConnection(admin, row, connection);
  await stopSandboxQuietly(row.sandbox_id, resolvedConnection);
  return snapshotFromRow(updated ?? { ...row, encrypted_auth_json: null, status: "expired" });
}

async function updateFlow(
  admin: AdminClient,
  row: FlowRow,
  values: Partial<Database["public"]["Tables"]["codex_device_auth_flows"]["Update"]>,
): Promise<FlowRow | null> {
  const { data, error } = await admin
    .from("codex_device_auth_flows")
    .update(values)
    .eq("id", row.id)
    .eq("user_id", row.user_id)
    .eq("status", row.status)
    .select(FLOW_SELECT)
    .maybeSingle();
  if (error) throw error;
  return data ?? getFlowRow(admin, { flowId: row.id, userId: row.user_id });
}

async function markFlowTerminal(
  admin: AdminClient,
  row: FlowRow,
  values: Partial<Database["public"]["Tables"]["codex_device_auth_flows"]["Update"]> & {
    status: CodexDeviceAuthStatus;
  },
): Promise<FlowRow | null> {
  return updateFlow(admin, row, values);
}

function snapshotFromRow(row: FlowRow): CodexDeviceAuthSnapshot {
  return {
    error: row.error,
    expiresAt: row.expires_at,
    flowId: row.id,
    instructions: row.instructions,
    status: row.status as CodexDeviceAuthStatus,
    userCode: normalizeUserCode(row.user_code),
    verificationUri: row.verification_uri,
  };
}

type AuthSandboxMetadata = {
  flowId: string;
  userId: string;
  workspaceId?: string;
};

async function createAuthSandbox(
  connection: SandboxConnection | undefined,
  metadata: AuthSandboxMetadata,
): Promise<AuthSandboxSession> {
  if (shouldUseLocalAuthSandbox()) {
    const cwd = await mkdtemp(join(tmpdir(), "wallie-codex-auth-"));
    const sandbox = new LocalAuthSandbox(`${LOCAL_SANDBOX_PREFIX}${randomUUID()}`, cwd);
    localSandboxes.set(sandbox.sandboxId, sandbox);
    return {
      codexHome: join(cwd, ".codex"),
      cwd,
      installCodex: false,
      sandbox,
    };
  }

  if (connection?.provider === "e2b") {
    const sandbox = await E2BSandbox.create({
      apiKey: connection.credentials.apiKey,
      envs: { CI: "1", CODEX_HOME: E2B_CODEX_HOME },
      lifecycle: { onTimeout: "kill" },
      metadata: {
        wallie_codex_auth_flow_id: metadata.flowId,
        wallie_codex_auth_user_id: metadata.userId,
        wallie_workspace_id: metadata.workspaceId ?? "unknown",
      },
      timeoutMs: FLOW_TTL_MS + 60_000,
    });
    return {
      codexHome: E2B_CODEX_HOME,
      cwd: E2B_SANDBOX_CWD,
      installCodex: true,
      sandbox: new E2BAuthSandbox(sandbox),
    };
  }

  if (connection?.provider === "daytona") {
    const client = createDaytonaAuthClient(connection);
    try {
      const sandbox = await client.create(
        {
          autoStopInterval: 0,
          ephemeral: true,
          envVars: { CI: "1", CODEX_HOME: DAYTONA_CODEX_HOME },
          image: "node:22-bookworm",
          labels: {
            wallie_codex_auth_flow_id: metadata.flowId,
            wallie_codex_auth_user_id: metadata.userId,
            wallie_workspace_id: metadata.workspaceId ?? "unknown",
          },
          resources: { cpu: 2, disk: 10, memory: 4 },
          ttlMinutes: Math.ceil((FLOW_TTL_MS + 60_000) / 60_000),
        },
        { timeout: 60 },
      );
      return {
        codexHome: DAYTONA_CODEX_HOME,
        cwd: DAYTONA_SANDBOX_CWD,
        installCodex: true,
        sandbox: new DaytonaAuthSandbox(client, sandbox),
      };
    } catch (error) {
      await client[Symbol.asyncDispose]();
      throw error;
    }
  }

  const vercelCredentials = connection?.provider === "vercel" ? connection.credentials : undefined;

  const sandbox = await Sandbox.create({
    ...resolveVercelCredentials(vercelCredentials),
    env: { CI: "1", CODEX_HOME: VERCEL_CODEX_HOME },
    resources: { vcpus: 1 },
    runtime: "node22",
    timeout: FLOW_TTL_MS + 60_000,
  });

  return {
    codexHome: VERCEL_CODEX_HOME,
    cwd: VERCEL_SANDBOX_CWD,
    installCodex: true,
    sandbox: sandbox as unknown as AuthSandbox,
  };
}

async function getAuthSandbox(
  sandboxId: string,
  connection?: SandboxConnection,
): Promise<AuthSandbox> {
  if (sandboxId.startsWith(LOCAL_SANDBOX_PREFIX)) {
    const sandbox = localSandboxes.get(sandboxId);
    if (!sandbox) {
      throw new Error("Local Codex sign-in process is no longer running. Start sign-in again.");
    }
    return sandbox;
  }

  if (connection?.provider === "e2b") {
    return new E2BAuthSandbox(
      await E2BSandbox.connect(sandboxId, { apiKey: connection.credentials.apiKey }),
    );
  }

  if (connection?.provider === "daytona") {
    const client = createDaytonaAuthClient(connection);
    try {
      return new DaytonaAuthSandbox(client, await client.get(sandboxId));
    } catch (error) {
      await client[Symbol.asyncDispose]();
      throw error;
    }
  }

  const vercelCredentials = connection?.provider === "vercel" ? connection.credentials : undefined;

  return Sandbox.get({
    ...resolveVercelCredentials(vercelCredentials),
    sandboxId,
  }) as unknown as AuthSandbox;
}

async function stopSandboxQuietly(
  sandboxId: string,
  connection?: SandboxConnection,
): Promise<void> {
  try {
    const sandbox = await getAuthSandbox(sandboxId, connection);
    await sandbox.stop();
  } catch {
    // The auth sandbox is short-lived and may already have stopped.
  }
}

async function resolveFlowConnection(
  admin: AdminClient,
  row: FlowRow,
  provided?: SandboxConnection,
): Promise<SandboxConnection | undefined> {
  const provider = normalizeSandboxProvider(row.sandbox_provider);
  if (!provider) return provided;
  if (
    provided?.provider === provider &&
    (row.sandbox_connection_revision == null ||
      String(provided.revision) === String(row.sandbox_connection_revision))
  ) {
    return provided;
  }
  if (row.workspace_id) {
    const record = await loadWorkspaceSandboxConnection(admin, row.workspace_id, provider);
    if (record) return record.connection;
  }
  throw new Error(
    `The ${providerLabel(provider)} connection used for this Codex sign-in is no longer available. Start sign-in again.`,
  );
}

function connectionFromInput(input: {
  connection?: SandboxConnection;
  vercelCredentials?: VercelSandboxCredentials;
}): SandboxConnection | undefined {
  if (input.connection) return input.connection;
  return input.vercelCredentials
    ? { credentials: input.vercelCredentials, provider: "vercel", revision: "legacy" }
    : undefined;
}

function normalizeSandboxProvider(value: string | null): SandboxProvider | null {
  return value === "vercel" || value === "e2b" || value === "daytona" ? value : null;
}

function providerLabel(provider: SandboxProvider): string {
  if (provider === "e2b") return "E2B";
  if (provider === "daytona") return "Daytona";
  return "Vercel Sandbox";
}

function codexAuthFileForProvider(provider: string | null): string {
  if (provider === "e2b") return `${E2B_CODEX_HOME}/auth.json`;
  if (provider === "daytona") return `${DAYTONA_CODEX_HOME}/auth.json`;
  return `${VERCEL_CODEX_HOME}/auth.json`;
}

function codexDeviceLoginCommand(
  session: Pick<AuthSandboxSession, "codexHome" | "installCodex">,
): string {
  const codexCommand = session.installCodex
    ? "codex"
    : "npm exec --yes --package @openai/codex -- codex";
  const script = [
    "set -euo pipefail",
    `export CODEX_HOME=${shellQuote(session.codexHome)}`,
    'mkdir -p "$CODEX_HOME"',
    ...(session.installCodex
      ? ["npm install -g @openai/codex >/tmp/wallie-codex-install.log 2>&1"]
      : []),
    `${codexCommand} login --device-auth -c ${shellQuote('cli_auth_credentials_store="file"')}`,
  ].join(" && ");
  return script;
}

async function readCommandOutput(command: AuthCommand, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let output = "";

  try {
    for await (const log of command.logs({ signal: controller.signal })) {
      output = limitOutput(output + log.data);
    }
  } catch (error) {
    if (!isAbortLikeError(error)) throw error;
  } finally {
    clearTimeout(timer);
  }

  return output;
}

async function readFinishedCommandOutput(command: AuthCommand, fallback: string): Promise<string> {
  try {
    return limitOutput(await command.output("both"));
  } catch {
    return fallback;
  }
}

async function waitForCommandExit(command: AuthCommand): Promise<AuthCommand> {
  if (command.exitCode !== null || !command.wait) return command;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMAND_STATUS_WAIT_MS);
  try {
    return await command.wait({ signal: controller.signal });
  } catch (error) {
    if (!isAbortLikeError(error)) throw error;
    return command;
  } finally {
    clearTimeout(timer);
  }
}

function parseDevicePrompt(output: string): {
  hasPrompt: boolean;
  instructions: string | null;
  userCode: string | null;
  verificationUri: string | null;
} {
  const cleanOutput = stripAnsiCodes(output);
  const verificationUri = extractVerificationUri(cleanOutput);
  const userCode = extractUserCode(cleanOutput);
  const hasPrompt = Boolean(verificationUri || userCode);
  return {
    hasPrompt,
    instructions: hasPrompt ? cleanOutput.trim() || null : null,
    userCode,
    verificationUri,
  };
}

function extractVerificationUri(output: string): string | null {
  return (
    output.match(/https:\/\/chatgpt\.com\/\S+/i)?.[0] ??
    output.match(/https:\/\/auth\.openai\.com\/\S+/i)?.[0] ??
    output.match(/https:\/\/platform\.openai\.com\/\S+/i)?.[0] ??
    null
  );
}

function extractUserCode(output: string): string | null {
  const withoutUrls = output.replace(/https?:\/\/\S+/gi, " ");
  const labeledPatterns = [
    new RegExp(
      `\\benter\\s+(?:this\\s+|the\\s+)?(?:(?:one[-\\s]time|user|device|verification)\\s+)?code\\b(?:\\s*\\([^\\n)]*\\))?(?:\\s+(?:shown|below|displayed))?(?:\\s+(?:in|on|at)\\b[^\\n:=-]*)?\\s*(?:is|:|=|-)?\\s*(${USER_CODE_PATTERN})`,
      "gi",
    ),
    new RegExp(
      `\\b(?:(?:one[-\\s]time|user|device|verification)\\s+)?code\\b(?:\\s*\\([^\\n)]*\\))?\\s*(?:is|:|=|-)\\s*(${USER_CODE_PATTERN})`,
      "gi",
    ),
    new RegExp(`\\btoken\\b\\s*(?:is|:|=|-)\\s*(${USER_CODE_PATTERN})`, "gi"),
  ];

  for (const pattern of labeledPatterns) {
    for (const match of withoutUrls.matchAll(pattern)) {
      const code = normalizeUserCode(match[1]);
      if (code) return code;
    }
  }

  const lines = withoutUrls.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!isCodePromptLine(lines[index] ?? "")) continue;

    for (const candidateLine of lines.slice(index + 1, index + 3)) {
      const code = normalizeUserCode(candidateLine);
      if (code) return code;
    }
  }

  for (const match of withoutUrls.matchAll(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/gi)) {
    const code = normalizeUserCode(match[0], { requireDigit: true });
    if (code) return code;
  }

  for (const line of withoutUrls.split(/\r?\n/)) {
    if (!/^[\sA-Z0-9-]+$/i.test(line.trim())) continue;
    const code = normalizeUserCode(line, { requireDigit: true });
    if (code) return code;
  }

  return null;
}

function isCodePromptLine(line: string): boolean {
  return /\benter\b.*\b(?:(?:one[-\s]time|user|device|verification)\s+)?code\b/i.test(line);
}

function normalizeUserCode(
  value: string | null | undefined,
  options: { requireDigit?: boolean } = {},
): string | null {
  if (!value) return null;

  const code = value
    .trim()
    .replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toUpperCase();

  if (!/^[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*$/.test(code)) return null;
  if (!isLikelyUserCode(code, options)) return null;
  return code;
}

function isLikelyUserCode(code: string, options: { requireDigit?: boolean } = {}): boolean {
  const segments = code.split("-");
  const compact = segments.join("");
  if (compact.length < 4 || compact.length > 32) return false;
  if (options.requireDigit && !/\d/.test(compact)) return false;
  if (segments.some((segment) => USER_CODE_STOP_WORDS.has(segment))) return false;
  if (USER_CODE_STOP_WORDS.has(compact)) return false;
  if (segments.length > 1) return true;
  if (/\d/.test(compact)) return true;
  return compact.length >= 6 && compact.length <= 10;
}

function stripAnsiCodes(output: string): string {
  return output.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function limitOutput(output: string): string {
  return output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output;
}

function redactAuthOutput(output: string): string {
  return output.replace(
    /\b(?:sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)\b/g,
    "[redacted]",
  );
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("abort"))
  );
}

function shouldUseLocalAuthSandbox(): boolean {
  const mode = process.env.CODEX_DEVICE_AUTH_MODE;
  if (mode === "local") return true;
  if (mode === "vercel") return false;

  return process.env.NODE_ENV === "development";
}

function resolveVercelCredentials(
  credentials?: VercelSandboxCredentials,
): { token: string; teamId: string; projectId: string } | Record<string, never> {
  if (credentials) return credentials;
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  return {};
}

const FILE_COMMAND_DIR = "/tmp/wallie-codex-auth";
type DaytonaConnection = Extract<SandboxConnection, { provider: "daytona" }>;

class FileBackedAuthCommand implements StartedAuthCommand {
  readonly outputIsSnapshot = true;
  exitCode: number | null = null;
  private readonly exitPath: string;
  private readonly logPath: string;

  constructor(
    readonly cmdId: string,
    private readonly sandbox: AuthSandbox,
  ) {
    this.exitPath = `${FILE_COMMAND_DIR}/${cmdId}.exit`;
    this.logPath = `${FILE_COMMAND_DIR}/${cmdId}.log`;
  }

  async *logs(input?: { signal?: AbortSignal }): AsyncIterable<AuthCommandLog> {
    let emitted = 0;
    while (true) {
      const output = await this.readOutput();
      if (output.length > emitted) {
        yield { data: output.slice(emitted) };
        emitted = output.length;
      }
      const exitCode = await this.readExitCode();
      if (exitCode !== null) return;
      await waitForAuthPoll(input?.signal);
    }
  }

  async output(): Promise<string> {
    return this.readOutput();
  }

  async wait(input?: { signal?: AbortSignal }): Promise<AuthCommand> {
    while (this.exitCode === null) {
      await this.readExitCode();
      if (this.exitCode === null) await waitForAuthPoll(input?.signal);
    }
    return this;
  }

  private async readOutput(): Promise<string> {
    return (await this.sandbox.readFileToBuffer({ path: this.logPath }))?.toString("utf8") ?? "";
  }

  private async readExitCode(): Promise<number | null> {
    const value = (await this.sandbox.readFileToBuffer({ path: this.exitPath }))
      ?.toString("utf8")
      .trim();
    if (!value) return null;
    const exitCode = Number.parseInt(value, 10);
    this.exitCode = Number.isFinite(exitCode) ? exitCode : 1;
    return this.exitCode;
  }
}

class E2BAuthSandbox implements AuthSandbox {
  constructor(private readonly sandbox: E2BSandbox) {}

  get sandboxId(): string {
    return this.sandbox.sandboxId;
  }

  async getCommand(commandId: string): Promise<AuthCommand> {
    return new FileBackedAuthCommand(commandId, this);
  }

  async readFileToBuffer(input: { path: string }): Promise<Buffer | null> {
    try {
      return Buffer.from(await this.sandbox.files.read(input.path), "utf8");
    } catch (error) {
      if (error instanceof E2BFileNotFoundError) return null;
      throw error;
    }
  }

  async runCommand(input: {
    args: string[];
    cmd: string;
    cwd: string;
    detached: boolean;
    env: Record<string, string>;
  }): Promise<StartedAuthCommand> {
    const commandId = randomUUID();
    const result = await this.sandbox.commands.run(fileBackedCommandLauncher(input, commandId), {
      cwd: input.cwd,
      envs: input.env,
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr || "Failed to start Codex sign-in.");
    return new FileBackedAuthCommand(commandId, this);
  }

  async stop(): Promise<void> {
    await this.sandbox.kill();
  }
}

class DaytonaAuthSandbox implements AuthSandbox {
  private disposed = false;

  constructor(
    private readonly client: Daytona,
    private readonly sandbox: Awaited<ReturnType<Daytona["create"]>>,
  ) {}

  get sandboxId(): string {
    return this.sandbox.id;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.client[Symbol.asyncDispose]();
  }

  async getCommand(commandId: string): Promise<AuthCommand> {
    return new FileBackedAuthCommand(commandId, this);
  }

  async readFileToBuffer(input: { path: string }): Promise<Buffer | null> {
    try {
      return await this.sandbox.fs.downloadFile(input.path);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw error;
    }
  }

  async runCommand(input: {
    args: string[];
    cmd: string;
    cwd: string;
    detached: boolean;
    env: Record<string, string>;
  }): Promise<StartedAuthCommand> {
    const commandId = randomUUID();
    const result = await this.sandbox.process.executeCommand(
      fileBackedCommandLauncher(input, commandId),
      input.cwd,
      input.env,
      30,
    );
    if (result.exitCode !== 0) throw new Error(result.result || "Failed to start Codex sign-in.");
    return new FileBackedAuthCommand(commandId, this);
  }

  async stop(): Promise<void> {
    try {
      await this.sandbox.delete(60, true);
    } catch (error) {
      if (!(error instanceof DaytonaNotFoundError)) throw error;
    } finally {
      await this.close();
    }
  }
}

function createDaytonaAuthClient(connection: DaytonaConnection): Daytona {
  return new Daytona({
    apiKey: connection.credentials.apiKey,
    apiUrl: connection.credentials.apiUrl ?? DAYTONA_CLOUD_API_URL,
    target: connection.credentials.target,
  });
}

function fileBackedCommandLauncher(
  input: { args: string[]; cmd: string },
  commandId: string,
): string {
  const exitPath = `${FILE_COMMAND_DIR}/${commandId}.exit`;
  const logPath = `${FILE_COMMAND_DIR}/${commandId}.log`;
  const command = [input.cmd, ...input.args].map(shellQuote).join(" ");
  const background = `${command}; status=$?; printf '%s' "$status" > ${shellQuote(exitPath)}`;
  return [
    `mkdir -p ${shellQuote(FILE_COMMAND_DIR)}`,
    `rm -f ${shellQuote(exitPath)} ${shellQuote(logPath)}`,
    `nohup sh -c ${shellQuote(background)} > ${shellQuote(logPath)} 2>&1 < /dev/null &`,
  ].join("; ");
}

function waitForAuthPoll(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 100);
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class LocalAuthSandbox implements AuthSandbox {
  private readonly commands = new Map<string, LocalAuthCommand>();
  readonly codexHome: string;

  constructor(
    readonly sandboxId: string,
    readonly cwd: string,
  ) {
    this.codexHome = join(cwd, ".codex");
  }

  async runCommand(input: {
    args: string[];
    cmd: string;
    cwd: string;
    detached: boolean;
    env: Record<string, string>;
  }): Promise<StartedAuthCommand> {
    const command = new LocalAuthCommand(randomUUID(), input);
    this.commands.set(command.cmdId, command);
    command.start();
    return command;
  }

  async getCommand(commandId: string): Promise<AuthCommand> {
    const command = this.commands.get(commandId);
    if (!command) {
      throw new Error("Local Codex sign-in process is no longer running. Start sign-in again.");
    }
    return command;
  }

  async readFileToBuffer(): Promise<Buffer | null> {
    try {
      return await readFile(join(this.codexHome, "auth.json"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    for (const command of this.commands.values()) {
      command.stop();
    }
    this.commands.clear();
    localSandboxes.delete(this.sandboxId);
    await rm(this.cwd, { force: true, recursive: true });
  }
}

class LocalAuthCommand implements StartedAuthCommand {
  private child: ReturnType<typeof spawn> | null = null;
  private readonly chunks: string[] = [];
  private readonly listeners = new Set<() => void>();
  exitCode: number | null = null;

  constructor(
    readonly cmdId: string,
    private readonly input: {
      args: string[];
      cmd: string;
      cwd: string;
      detached: boolean;
      env: Record<string, string>;
    },
  ) {}

  start(): void {
    const child = spawn(this.input.cmd, this.input.args, {
      cwd: this.input.cwd,
      detached: this.input.detached,
      env: { ...process.env, ...this.input.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;

    if (!child.stdout || !child.stderr) {
      throw new Error("Failed to capture local Codex sign-in output.");
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.append(String(chunk)));
    child.stderr.on("data", (chunk) => this.append(String(chunk)));
    child.on("error", (error) => {
      this.append(error.message);
      this.exitCode = 1;
      this.notify();
    });
    child.on("close", (code) => {
      this.exitCode = code ?? 1;
      this.notify();
    });
    if (this.input.detached) {
      child.unref();
    }
  }

  async *logs(input?: { signal?: AbortSignal }): AsyncIterable<AuthCommandLog> {
    if (this.chunks.length === 0 && this.exitCode === null) {
      await this.waitForChunk(input?.signal);
    }

    for (const chunk of this.chunks) {
      yield { data: chunk };
    }
  }

  async output(): Promise<string> {
    return limitOutput(this.chunks.join(""));
  }

  async wait(input?: { signal?: AbortSignal }): Promise<AuthCommand> {
    while (this.exitCode === null) {
      await this.waitForChunk(input?.signal);
    }
    return this;
  }

  stop(): void {
    if (!this.child || this.exitCode !== null) return;
    try {
      if (this.child.pid && this.input.detached) {
        process.kill(-this.child.pid, "SIGTERM");
      } else {
        this.child.kill("SIGTERM");
      }
    } catch {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // The local Codex process may have already exited.
      }
    }
  }

  private append(chunk: string): void {
    this.chunks.push(chunk);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
    this.listeners.clear();
  }

  private waitForChunk(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const onSignal = () => {
        cleanup();
        reject(abortError());
      };
      const onChunk = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        this.listeners.delete(onChunk);
        signal?.removeEventListener("abort", onSignal);
      };

      this.listeners.add(onChunk);
      signal?.addEventListener("abort", onSignal, { once: true });
    });
  }
}

function abortError(): Error {
  const error = new Error("The Codex sign-in log read was aborted.");
  error.name = "AbortError";
  return error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim().length > 0) return error;
  return fallback;
}

function startAuthErrorMessage(error: unknown): string {
  const message = errorMessage(error, "Failed to start Codex sign-in.");
  if (isPaymentRequiredError(message)) return SANDBOX_PAYMENT_REQUIRED_MESSAGE;
  return message;
}

function pollAuthErrorMessage(error: unknown): string {
  const message = errorMessage(error, "Failed to read Codex sign-in status.");
  if (isPaymentRequiredError(message)) return SANDBOX_PAYMENT_REQUIRED_MESSAGE;
  return message;
}

function commandFailureMessage(output: string, exitCode: number): string {
  const redactedOutput = redactAuthOutput(output).trim();
  if (isPaymentRequiredError(redactedOutput)) return CHATGPT_CODEX_PAYMENT_REQUIRED_MESSAGE;
  return redactedOutput || `Codex login exited with code ${exitCode}.`;
}

function isPaymentRequiredError(message: string): boolean {
  return /\b402\b/.test(message) && /(?:payment\s+required|status\s+code|not\s+ok)/i.test(message);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
