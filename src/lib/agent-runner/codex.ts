import { parseCodexChatGptAuthJson } from "@/lib/codex/auth-json";
import {
  CodexAuthLeaseBusyError,
  type ChatGptCodexCredential,
  type CodexChatGptAuthStore,
  type CodexCredential,
} from "@/lib/codex/contracts";
import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from "./types";

const PROMPT_FILE_NAME = ".wallie-prompt.txt";
const CODEX_HOME_DIR = ".codex";
const CODEX_AUTH_FILE_NAME = "auth.json";
const CHATGPT_AUTH_LEASE_MS = 35 * 60_000;
export const CODEX_EXTERNAL_SANDBOX_FLAG = "--dangerously-bypass-approvals-and-sandbox";
export const CODEX_SANDBOX_MODE = "danger-full-access";

export interface CodexRunnerOptions {
  /** User-supplied Codex credential resolved by getCodexCredentialForUser. */
  credential: CodexCredential;
  /** Required for ChatGPT subscription auth so the runner can lease and persist auth.json. */
  chatGptAuthStore?: CodexChatGptAuthStore;
  /** Model identifier (e.g. "gpt-5.5"). */
  model?: string;
}

/**
 * Codex CLI agent runner.
 *
 * Runs `codex exec` inside a per-session sandbox. API keys and Codex access
 * tokens are injected only into the process environment. ChatGPT subscription
 * auth writes a leased Codex auth.json before the run and persists any
 * refreshed auth cache after the CLI exits. Streams stdout line-by-line as
 * AgentEvents.
 *
 * Expects `codex` on PATH inside the sandbox (installed at sandbox boot).
 */
export class CodexRunner implements AgentRunner {
  readonly provider = "codex";
  readonly requiresSandbox = true;

  constructor(private readonly options: CodexRunnerOptions) {
    if (!options.credential?.secret) {
      throw new Error("CodexRunner requires a Codex credential.");
    }
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    if (!sandbox) {
      throw new Error("CodexRunner requires a sandbox.");
    }

    if (this.options.credential.type === "chatgpt_auth_json") {
      yield* this.startWithChatGptAuth(input);
      return;
    }

    const model = this.options.model ?? DEFAULT_CODEX_MODEL;
    const promptFile = promptFileFor(sandbox);
    const codexHome = codexHomeFor(sandbox);

    await sandbox.writeFile(promptFile, input.prompt);
    if (this.options.credential.type !== "codex_access_token") {
      await ensureCodexHome(sandbox, codexHome);
    }

    const shellCmd = codexCommandForCredential(
      model,
      this.options.credential,
      codexHome,
      promptFile,
      sandbox.repoPath,
    );

    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: { CI: "1", CODEX_HOME: codexHome, ...codexCredentialEnv(this.options.credential) },
    });

    let stdoutBuf = "";
    let stderrBuf = "";

    for await (const log of proc.logs()) {
      if (log.stream === "stderr") {
        stderrBuf += log.data;
        continue;
      }

      stdoutBuf += log.data;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseCodexLine(line);
        if (event) yield event;
      }
    }

    if (stdoutBuf.trim()) {
      const event = parseCodexLine(stdoutBuf);
      if (event) yield event;
    }

    const code = await proc.exitCode;
    if (code !== 0) {
      yield {
        type: "error",
        message: codexExitErrorMessage(code, stderrBuf),
      };
    }

    yield {
      type: "completion",
      taskComplete: true,
      summary: "Codex session completed",
    };
  }

  private async *startWithChatGptAuth(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    if (!sandbox) {
      throw new Error("CodexRunner requires a sandbox.");
    }

    const credential = this.options.credential;
    if (credential.type !== "chatgpt_auth_json") {
      throw new Error("CodexRunner expected ChatGPT subscription auth.");
    }

    const runId = input.runId;
    if (!runId) {
      throw new Error("CodexRunner requires runId for ChatGPT subscription auth.");
    }

    const store = this.options.chatGptAuthStore;
    if (!store) {
      throw new Error("CodexRunner requires a ChatGPT auth store for subscription auth.");
    }

    const leaseExpiresAt = new Date(Date.now() + CHATGPT_AUTH_LEASE_MS).toISOString();
    const leased = await store.acquireChatGptAuthLease({
      leaseExpiresAt,
      runId,
      userId: credential.userId,
    });
    if (!leased) {
      throw new CodexAuthLeaseBusyError();
    }

    try {
      yield* this.runWithLeasedChatGptAuth(input, leased, store);
    } finally {
      await store.releaseChatGptAuthLease({
        runId,
        userId: leased.userId,
      });
    }
  }

  private async *runWithLeasedChatGptAuth(
    input: AgentRunnerStartInput,
    credential: ChatGptCodexCredential,
    store: CodexChatGptAuthStore,
  ): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    if (!sandbox || !input.runId) return;

    const model = this.options.model ?? DEFAULT_CODEX_MODEL;
    const promptFile = promptFileFor(sandbox);
    const codexHome = codexHomeFor(sandbox);
    const codexAuthFile = codexAuthFileFor(sandbox);
    await sandbox.writeFile(promptFile, input.prompt);
    await ensureCodexHome(sandbox, codexHome);
    await sandbox.writeFile(codexAuthFile, credential.secret, { mode: 0o600 });

    const proc = await sandbox.exec(
      "bash",
      ["-lc", codexExecCommand(model, promptFile, sandbox.repoPath)],
      {
        cwd: sandbox.repoPath,
        env: { CI: "1", CODEX_HOME: codexHome },
      },
    );

    let stdoutBuf = "";
    let stderrBuf = "";

    for await (const log of proc.logs()) {
      if (log.stream === "stderr") {
        stderrBuf += log.data;
        continue;
      }

      stdoutBuf += log.data;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseCodexLine(line);
        if (event) yield event;
      }
    }

    if (stdoutBuf.trim()) {
      const event = parseCodexLine(stdoutBuf);
      if (event) yield event;
    }

    await persistRefreshedChatGptAuthJson({
      credential,
      runId: input.runId,
      sandbox,
      store,
    });

    const code = await proc.exitCode;
    if (code !== 0) {
      const message = codexExitErrorMessage(code, stderrBuf);
      if (isAuthFailure(message)) {
        await store.markChatGptAuthReconnectRequired({
          reason:
            "The saved ChatGPT Codex sign-in is no longer valid. Reconnect Codex in Settings.",
          runId: input.runId,
          userId: credential.userId,
        });
      }

      yield {
        type: "error",
        message,
      };
    }

    yield {
      type: "completion",
      taskComplete: true,
      summary: "Codex session completed",
    };
  }
}

/**
 * Parse a single line of Codex CLI `--json` output. One JSON object per line.
 * Known event shapes:
 *   { type: "message", role: "assistant", content: "..." }
 *   { type: "text", text: "..." }
 *   { type: "tool_call", name: "...", arguments: {...} }
 *   { type: "item.completed", item: { type: "agent_message", text: "..." } }
 *   { type: "turn.completed", usage: {...} }
 *   { type: "result", summary: "..." }
 * Unknown JSON bookkeeping shapes are ignored; non-JSON stdout falls through
 * to raw text so we don't silently drop plain output.
 */
export function parseCodexLine(raw: string): AgentEvent | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;

    if (obj.type === "text" && typeof obj.text === "string") {
      return { type: "text", text: obj.text };
    }

    if (obj.type === "message" && typeof obj.content === "string") {
      return { type: "text", text: obj.content };
    }

    if (obj.type === "tool_call" && typeof obj.name === "string") {
      const input =
        typeof obj.arguments === "string" ? obj.arguments : JSON.stringify(obj.arguments ?? {});
      return { type: "tool_use", tool: obj.name, input };
    }

    if (obj.type === "item.completed" && isRecord(obj.item)) {
      return parseCodexItem(obj.item);
    }

    if (obj.type === "turn.completed") {
      const event: AgentEvent = {
        type: "completion",
        taskComplete: true,
        summary: "Codex turn completed",
      };
      const usage = parseCodexUsage(obj.usage);
      if (usage) event.usage = usage;
      return event;
    }

    if (obj.type === "result") {
      const summary =
        typeof obj.summary === "string"
          ? obj.summary
          : typeof obj.result === "string"
            ? obj.result
            : "Codex run finished";
      const event: AgentEvent = {
        type: "completion",
        taskComplete: true,
        summary,
      };
      const usage = parseCodexUsage(obj.usage);
      if (usage) event.usage = usage;
      return event;
    }

    return null;
  } catch {
    return { type: "text", text: trimmed };
  }
}

function parseCodexItem(item: Record<string, unknown>): AgentEvent | null {
  if (item.type === "agent_message") {
    const text = textFromCodexContent(item.text ?? item.content);
    return text ? { type: "text", text } : null;
  }

  if (
    (item.type === "tool_call" || item.type === "function_call") &&
    typeof item.name === "string"
  ) {
    const rawInput = item.arguments ?? item.input ?? {};
    return {
      type: "tool_use",
      tool: item.name,
      input: typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput),
    };
  }

  return null;
}

function textFromCodexContent(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (isRecord(block) && typeof block.text === "string") {
      parts.push(block.text);
    }
  }

  const text = parts.join("\n").trim();
  return text || null;
}

function parseCodexUsage(
  usage: unknown,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }

  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    return undefined;
  }

  return { inputTokens, outputTokens };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codexCredentialEnv(credential: CodexCredential): Record<string, string> {
  switch (credential.type) {
    case "chatgpt_auth_json":
      return {};
    case "codex_access_token":
      return { CODEX_ACCESS_TOKEN: credential.secret };
    case "platform_api_key":
      return { CODEX_API_KEY: credential.secret, OPENAI_API_KEY: credential.secret };
  }
}

function promptFileFor(sandbox: NonNullable<AgentRunnerStartInput["sandbox"]>): string {
  return `${sandbox.repoPath}/${PROMPT_FILE_NAME}`;
}

function codexHomeFor(sandbox: NonNullable<AgentRunnerStartInput["sandbox"]>): string {
  return `${sandbox.repoPath}/${CODEX_HOME_DIR}`;
}

function codexAuthFileFor(sandbox: NonNullable<AgentRunnerStartInput["sandbox"]>): string {
  return `${codexHomeFor(sandbox)}/${CODEX_AUTH_FILE_NAME}`;
}

function codexCommandForCredential(
  model: string,
  credential: CodexCredential,
  codexHome: string,
  promptFile: string,
  sandboxRepoPath: string,
): string {
  if (credential.type !== "codex_access_token") {
    return codexExecCommand(model, promptFile, sandboxRepoPath);
  }

  const loginCommand = [
    `mkdir -p ${shellQuote(codexHome)}`,
    `printf '%s' "$CODEX_ACCESS_TOKEN" | codex login --with-access-token -c ${shellQuote(
      `cli_auth_credentials_store="file"`,
    )} >/dev/stderr`,
  ].join(" && ");
  return `${loginCommand} && ${codexExecCommand(model, promptFile, sandboxRepoPath)}`;
}

async function persistRefreshedChatGptAuthJson(input: {
  credential: ChatGptCodexCredential;
  runId: string;
  sandbox: NonNullable<AgentRunnerStartInput["sandbox"]>;
  store: CodexChatGptAuthStore;
}) {
  const refreshedAuthJson = await input.sandbox.readFile(codexAuthFileFor(input.sandbox));
  if (!refreshedAuthJson || refreshedAuthJson === input.credential.secret) return;

  const metadata = parseCodexChatGptAuthJson(refreshedAuthJson);
  await input.store.persistChatGptAuthJson({
    authJson: refreshedAuthJson,
    metadata,
    previousCredentialVersion: input.credential.credentialVersion,
    runId: input.runId,
    userId: input.credential.userId,
  });
}

export function codexExecArgs(model: string, sandboxRepoPath: string): string[] {
  return [
    "exec",
    "--model",
    model,
    "--sandbox",
    CODEX_SANDBOX_MODE,
    "-c",
    `model_reasoning_effort="${DEFAULT_CODEX_REASONING_EFFORT}"`,
    "-c",
    `cli_auth_credentials_store="file"`,
    CODEX_EXTERNAL_SANDBOX_FLAG,
    "--cd",
    sandboxRepoPath,
    "--json",
    "-",
  ];
}

function codexExecCommand(model: string, promptFile: string, sandboxRepoPath: string): string {
  return `codex ${codexExecArgs(model, sandboxRepoPath).map(shellQuote).join(" ")} < ${shellQuote(
    promptFile,
  )}`;
}

async function ensureCodexHome(
  sandbox: NonNullable<AgentRunnerStartInput["sandbox"]>,
  codexHome: string,
) {
  const proc = await sandbox.exec("bash", ["-lc", `mkdir -p ${shellQuote(codexHome)}`], {
    cwd: sandbox.repoPath,
    env: { CI: "1" },
  });
  let stderr = "";
  for await (const log of proc.logs()) {
    if (log.stream === "stderr") stderr += log.data;
  }

  const code = await proc.exitCode;
  if (code !== 0) {
    throw new Error(`Failed to create Codex auth directory: ${stderr.slice(0, 500)}`);
  }
}

function isAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    /\b401\b/.test(lower) ||
    /\bunauthorized\b/.test(lower) ||
    /\bnot authenticated\b/.test(lower) ||
    /\bauth(?:entication)? (?:failed|required|error)\b/.test(lower) ||
    /\binvalid (?:credential|credentials|grant|api key)\b/.test(lower) ||
    /\b(?:access|refresh) token (?:expired|invalid|revoked)\b/.test(lower)
  );
}

function codexExitErrorMessage(code: number, stderr: string): string {
  const excerpt = stderr.slice(0, 500);
  if (isCodexInnerSandboxFailure(stderr)) {
    return [
      `codex CLI exited with code ${code}: Codex's inner Bubblewrap sandbox was invoked unexpectedly inside Vercel Sandbox.`,
      `Wallie should run Codex with ${CODEX_EXTERNAL_SANDBOX_FLAG}.`,
      `Raw stderr: ${excerpt || "(empty)"}`,
    ].join(" ");
  }
  return `codex CLI exited with code ${code}: ${excerpt}`;
}

function isCodexInnerSandboxFailure(stderr: string): boolean {
  return /\b(?:bwrap|bubblewrap)\b|No permissions to create a new namespace/i.test(stderr);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
