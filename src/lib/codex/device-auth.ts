import "server-only";

import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCodexChatGptAuthJson } from "@/lib/codex/auth-json";
import type { CodexAuthJsonMetadata } from "@/lib/codex/contracts";

const FLOW_TTL_MS = 10 * 60_000;
const PROMPT_WAIT_MS = 2_500;
const MAX_OUTPUT_CHARS = 4_000;

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

interface CodexDeviceAuthFlow extends CodexDeviceAuthSnapshot {
  authJson: string | null;
  metadata: CodexAuthJsonMetadata | null;
  notify: Set<() => void>;
  proc: ChildProcessWithoutNullStreams | null;
  tempHome: string;
  userId: string;
}

const flows = new Map<string, CodexDeviceAuthFlow>();

export async function startCodexDeviceAuthFlow(input: {
  userId: string;
}): Promise<CodexDeviceAuthSnapshot> {
  pruneExpiredFlows();

  const flowId = randomUUID();
  const tempHome = await mkdtemp(join(tmpdir(), "wallie-codex-auth-"));
  const expiresAt = new Date(Date.now() + FLOW_TTL_MS).toISOString();
  const flow: CodexDeviceAuthFlow = {
    authJson: null,
    error: null,
    expiresAt,
    flowId,
    instructions: null,
    metadata: null,
    notify: new Set(),
    proc: null,
    status: "starting",
    tempHome,
    userCode: null,
    userId: input.userId,
    verificationUri: null,
  };
  flows.set(flowId, flow);

  try {
    flow.proc = spawn(
      "codex",
      ["login", "--device-auth", "-c", 'cli_auth_credentials_store="file"'],
      {
        env: {
          ...process.env,
          CI: "1",
          CODEX_HOME: tempHome,
        },
      },
    );
  } catch (error) {
    flow.status = "error";
    flow.error = error instanceof Error ? error.message : "Failed to start Codex login.";
    notify(flow);
    await cleanupFlowFiles(flow);
    return snapshot(flow);
  }

  let output = "";
  const appendOutput = (chunk: Buffer) => {
    output = limitOutput(output + chunk.toString("utf8"));
    updatePromptFromOutput(flow, output);
  };

  flow.proc.stdout.on("data", appendOutput);
  flow.proc.stderr.on("data", appendOutput);
  flow.proc.on("error", async (error) => {
    flow.status = "error";
    flow.error = error.message;
    notify(flow);
    await cleanupFlowFiles(flow);
  });
  flow.proc.on("exit", async (code) => {
    if (flow.status === "canceled" || flow.status === "expired") {
      await cleanupFlowFiles(flow);
      return;
    }

    if (code !== 0) {
      flow.status = "error";
      flow.error = output.trim() || `Codex login exited with code ${code ?? "unknown"}.`;
      notify(flow);
      await cleanupFlowFiles(flow);
      return;
    }

    try {
      const authJson = await readFile(join(tempHome, "auth.json"), "utf8");
      const metadata = parseCodexChatGptAuthJson(authJson);
      flow.authJson = authJson;
      flow.metadata = metadata;
      flow.status = "authenticated";
      flow.error = null;
      notify(flow);
    } catch (error) {
      flow.status = "error";
      flow.error =
        error instanceof Error
          ? error.message
          : "Codex login completed without a valid auth cache.";
      notify(flow);
      await cleanupFlowFiles(flow);
    }
  });

  await waitForFlowUpdate(flow, PROMPT_WAIT_MS);
  return snapshot(flow);
}

export function getCodexDeviceAuthFlowSnapshot(input: {
  flowId: string;
  userId: string;
}): CodexDeviceAuthSnapshot | null {
  const flow = getUserFlow(input);
  if (!flow) return null;
  expireFlowIfNeeded(flow);
  return snapshot(flow);
}

export function consumeAuthenticatedCodexDeviceAuthFlow(input: {
  flowId: string;
  userId: string;
}): {
  authJson: string;
  metadata: CodexAuthJsonMetadata;
  snapshot: CodexDeviceAuthSnapshot;
} | null {
  const flow = getUserFlow(input);
  if (!flow) return null;
  expireFlowIfNeeded(flow);
  if (flow.status !== "authenticated" || !flow.authJson || !flow.metadata) {
    return null;
  }

  flows.delete(flow.flowId);
  void cleanupFlowFiles(flow);
  return {
    authJson: flow.authJson,
    metadata: flow.metadata,
    snapshot: snapshot(flow),
  };
}

export async function cancelCodexDeviceAuthFlow(input: {
  flowId: string;
  userId: string;
}): Promise<boolean> {
  const flow = getUserFlow(input);
  if (!flow) return false;
  flow.status = "canceled";
  flow.proc?.kill("SIGTERM");
  flows.delete(flow.flowId);
  notify(flow);
  await cleanupFlowFiles(flow);
  return true;
}

async function waitForFlowUpdate(flow: CodexDeviceAuthFlow, timeoutMs: number): Promise<void> {
  if (flow.status !== "starting") return;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, timeoutMs);

    function done() {
      clearTimeout(timeout);
      flow.notify.delete(done);
      resolve();
    }

    flow.notify.add(done);
  });
}

function updatePromptFromOutput(flow: CodexDeviceAuthFlow, output: string) {
  if (flow.status !== "starting" && flow.status !== "prompted") return;

  const verificationUri = extractVerificationUri(output);
  const userCode = extractUserCode(output);
  if (!verificationUri && !userCode) return;

  flow.status = "prompted";
  flow.verificationUri = verificationUri ?? flow.verificationUri;
  flow.userCode = userCode ?? flow.userCode;
  flow.instructions = output.trim() || null;
  notify(flow);
}

function extractVerificationUri(output: string): string | null {
  return (
    output.match(/https:\/\/(?:chatgpt\.com|auth\.openai\.com|platform\.openai\.com)\/\S+/i)?.[0] ??
    output.match(/https:\/\/\S+/i)?.[0] ??
    null
  );
}

function extractUserCode(output: string): string | null {
  const withoutUrls = output.replace(/https?:\/\/\S+/gi, " ");
  const labeled = withoutUrls.match(/(?:code|token)[:\s]+([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})*)/i);
  if (labeled?.[1]) return labeled[1].toUpperCase();

  return withoutUrls.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/)?.[0] ?? null;
}

function snapshot(flow: CodexDeviceAuthFlow): CodexDeviceAuthSnapshot {
  return {
    error: flow.error,
    expiresAt: flow.expiresAt,
    flowId: flow.flowId,
    instructions: flow.instructions,
    status: flow.status,
    userCode: flow.userCode,
    verificationUri: flow.verificationUri,
  };
}

function getUserFlow(input: { flowId: string; userId: string }): CodexDeviceAuthFlow | null {
  const flow = flows.get(input.flowId);
  if (!flow || flow.userId !== input.userId) return null;
  return flow;
}

function expireFlowIfNeeded(flow: CodexDeviceAuthFlow) {
  if (new Date(flow.expiresAt).getTime() > Date.now()) return;
  flow.status = "expired";
  flow.proc?.kill("SIGTERM");
  flows.delete(flow.flowId);
  notify(flow);
  void cleanupFlowFiles(flow);
}

function pruneExpiredFlows() {
  for (const flow of flows.values()) {
    expireFlowIfNeeded(flow);
  }
}

function notify(flow: CodexDeviceAuthFlow) {
  for (const listener of flow.notify) listener();
}

function limitOutput(output: string): string {
  return output.length > MAX_OUTPUT_CHARS ? output.slice(-MAX_OUTPUT_CHARS) : output;
}

async function cleanupFlowFiles(flow: CodexDeviceAuthFlow): Promise<void> {
  await rm(flow.tempHome, { force: true, recursive: true }).catch(() => undefined);
}
