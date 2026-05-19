import "server-only";

import { randomUUID } from "node:crypto";

import { Sandbox } from "@vercel/sandbox";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseCodexChatGptAuthJson } from "@/lib/codex/auth-json";
import type { CodexAuthJsonMetadata } from "@/lib/codex/contracts";
import { encryptSecretValue, decryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

const FLOW_TTL_MS = 10 * 60_000;
const PROMPT_WAIT_MS = 2_500;
const POLL_WAIT_MS = 750;
const MAX_OUTPUT_CHARS = 4_000;
const CODEX_HOME = "/vercel/sandbox/.codex";
const CODEX_AUTH_FILE = `${CODEX_HOME}/auth.json`;

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

const ACTIVE_FLOW_STATUSES: CodexDeviceAuthStatus[] = ["starting", "prompted", "authenticated"];
const FLOW_SELECT =
  "id, user_id, status, sandbox_id, command_id, verification_uri, user_code, instructions, error, encrypted_auth_json, account_id, account_email, auth_cache_last_refresh, output_tail, expires_at, completed_at, canceled_at, created_at, updated_at";

export async function startCodexDeviceAuthFlow(input: {
  userId: string;
}): Promise<CodexDeviceAuthSnapshot> {
  const admin = createSupabaseAdminClient();
  await expireStaleUserFlows(admin, input.userId);
  await cancelActiveUserFlows(admin, input.userId);

  const flowId = randomUUID();
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS).toISOString();
  let sandbox: Sandbox | null = null;

  try {
    sandbox = await createAuthSandbox();
    const command = await sandbox.runCommand({
      args: ["-lc", codexDeviceLoginCommand()],
      cmd: "bash",
      cwd: "/vercel/sandbox",
      detached: true,
      env: { CI: "1", CODEX_HOME },
    });

    const { data, error } = await admin
      .from("codex_device_auth_flows")
      .insert({
        command_id: command.cmdId,
        expires_at: expiresAt,
        id: flowId,
        sandbox_id: sandbox.sandboxId,
        status: "starting",
        user_id: input.userId,
      })
      .select(FLOW_SELECT)
      .single();
    if (error) throw error;

    return (
      (await refreshFlowFromSandbox(admin, data, {
        waitMs: PROMPT_WAIT_MS,
      })) ?? snapshotFromRow(data)
    );
  } catch (error) {
    if (sandbox) {
      await stopSandboxQuietly(sandbox.sandboxId);
    }

    return {
      error: error instanceof Error ? error.message : "Failed to start Codex sign-in.",
      expiresAt,
      flowId,
      instructions: null,
      status: "error",
      userCode: null,
      verificationUri: null,
    };
  }
}

export async function getCodexDeviceAuthFlowSnapshot(input: {
  flowId: string;
  userId: string;
}): Promise<CodexDeviceAuthSnapshot | null> {
  const admin = createSupabaseAdminClient();
  const row = await getFlowRow(admin, input);
  if (!row) return null;
  return refreshFlowFromSandbox(admin, row, { waitMs: POLL_WAIT_MS });
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

  await admin.from("codex_device_auth_flows").delete().eq("id", row.id).eq("user_id", input.userId);
  await stopSandboxQuietly(row.sandbox_id);

  return {
    authJson,
    metadata,
    snapshot: snapshotFromRow(row),
  };
}

export async function cancelCodexDeviceAuthFlow(input: {
  flowId: string;
  userId: string;
}): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  const row = await getFlowRow(admin, input);
  if (!row) return false;

  await markFlowTerminal(admin, row, {
    canceled_at: new Date().toISOString(),
    encrypted_auth_json: null,
    error: null,
    status: "canceled",
  });
  await stopSandboxQuietly(row.sandbox_id);
  return true;
}

async function refreshFlowFromSandbox(
  admin: AdminClient,
  row: FlowRow,
  input: { waitMs: number },
): Promise<CodexDeviceAuthSnapshot> {
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return expireFlow(admin, row);
  }

  if (
    row.status === "authenticated" ||
    row.status === "canceled" ||
    row.status === "error" ||
    row.status === "expired"
  ) {
    return snapshotFromRow(row);
  }

  try {
    const sandbox = await getAuthSandbox(row.sandbox_id);
    const command = await sandbox.getCommand(row.command_id);
    const output = limitOutput(
      `${row.output_tail ?? ""}${await readCommandOutput(command, input.waitMs)}`,
    );
    const prompt = parseDevicePrompt(output);

    const refreshedCommand = await sandbox.getCommand(row.command_id);
    if (refreshedCommand.exitCode === null) {
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
        error:
          redactAuthOutput(finalOutput).trim() ||
          `Codex login exited with code ${refreshedCommand.exitCode}.`,
        output_tail: finalOutput,
        status: "error",
      });
      await stopSandboxQuietly(row.sandbox_id);
      return snapshotFromRow(updated ?? row);
    }

    const authJsonBuffer = await sandbox.readFileToBuffer({ path: CODEX_AUTH_FILE });
    if (!authJsonBuffer) {
      const updated = await markFlowTerminal(admin, row, {
        encrypted_auth_json: null,
        error: "Codex login completed without a valid auth cache.",
        output_tail: finalOutput,
        status: "error",
      });
      await stopSandboxQuietly(row.sandbox_id);
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
    await stopSandboxQuietly(row.sandbox_id);
    return snapshotFromRow(updated ?? row);
  } catch (error) {
    const updated = await markFlowTerminal(admin, row, {
      encrypted_auth_json: null,
      error: error instanceof Error ? error.message : "Failed to read Codex sign-in status.",
      status: "error",
    });
    await stopSandboxQuietly(row.sandbox_id);
    return snapshotFromRow(updated ?? row);
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
    await expireFlow(admin, row);
  }
}

async function cancelActiveUserFlows(admin: AdminClient, userId: string): Promise<void> {
  const { data, error } = await admin
    .from("codex_device_auth_flows")
    .select(FLOW_SELECT)
    .eq("user_id", userId)
    .in("status", ACTIVE_FLOW_STATUSES);
  if (error) throw error;

  for (const row of data ?? []) {
    await markFlowTerminal(admin, row, {
      canceled_at: new Date().toISOString(),
      encrypted_auth_json: null,
      error: null,
      status: "canceled",
    });
    await stopSandboxQuietly(row.sandbox_id);
  }
}

async function expireFlow(admin: AdminClient, row: FlowRow): Promise<CodexDeviceAuthSnapshot> {
  const updated = await markFlowTerminal(admin, row, {
    encrypted_auth_json: null,
    error: null,
    status: "expired",
  });
  await stopSandboxQuietly(row.sandbox_id);
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
    .select(FLOW_SELECT)
    .single();
  if (error) throw error;
  return data;
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
    userCode: row.user_code,
    verificationUri: row.verification_uri,
  };
}

async function createAuthSandbox(): Promise<Sandbox> {
  return Sandbox.create({
    ...resolveVercelCredentials(),
    env: { CI: "1", CODEX_HOME },
    resources: { vcpus: 1 },
    runtime: "node22",
    timeout: FLOW_TTL_MS + 60_000,
  });
}

async function getAuthSandbox(sandboxId: string): Promise<Sandbox> {
  return Sandbox.get({
    ...resolveVercelCredentials(),
    sandboxId,
  });
}

async function stopSandboxQuietly(sandboxId: string): Promise<void> {
  try {
    const sandbox = await getAuthSandbox(sandboxId);
    await sandbox.stop();
  } catch {
    // The auth sandbox is short-lived and may already have stopped.
  }
}

function codexDeviceLoginCommand(): string {
  const script = [
    "set -euo pipefail",
    `export CODEX_HOME=${shellQuote(CODEX_HOME)}`,
    'mkdir -p "$CODEX_HOME"',
    "npm install -g @openai/codex >/tmp/wallie-codex-install.log 2>&1",
    `codex login --device-auth -c ${shellQuote('cli_auth_credentials_store="file"')}`,
  ].join(" && ");
  return script;
}

async function readCommandOutput(
  command: Awaited<ReturnType<Sandbox["getCommand"]>>,
  timeoutMs: number,
): Promise<string> {
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

async function readFinishedCommandOutput(
  command: Awaited<ReturnType<Sandbox["getCommand"]>>,
  fallback: string,
): Promise<string> {
  try {
    return limitOutput(await command.output("both"));
  } catch {
    return fallback;
  }
}

function parseDevicePrompt(output: string): {
  hasPrompt: boolean;
  instructions: string | null;
  userCode: string | null;
  verificationUri: string | null;
} {
  const verificationUri = extractVerificationUri(output);
  const userCode = extractUserCode(output);
  const hasPrompt = Boolean(verificationUri || userCode);
  return {
    hasPrompt,
    instructions: hasPrompt ? output.trim() || null : null,
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
  const labeled = withoutUrls.match(/(?:code|token)[:\s]+([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*)/i);
  if (labeled?.[1]) return labeled[1].toUpperCase();

  return withoutUrls.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/)?.[0] ?? null;
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

function resolveVercelCredentials():
  | { token: string; teamId: string; projectId: string }
  | Record<string, never> {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  return {};
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
