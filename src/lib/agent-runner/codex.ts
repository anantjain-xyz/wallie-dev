import { parseCodexChatGptAuthJson } from "@/lib/codex/auth-json";
import {
  type ChatGptCodexCredential,
  type CodexChatGptAuthStore,
  type CodexCredential,
} from "@/lib/codex/contracts";
import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { redactRunSensitiveText, redactRunToolText } from "./redact-sensitive-text";
import { ToolEventTracker } from "./tool-event-tracker";
import { AgentOutputSafety, prepareRunnerDirectory } from "./safety";
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from "./types";
import type { AgentEffort } from "@/lib/agent-config/contracts";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import { shellQuote } from "@/lib/sandbox/command";
import { normalizeMeasuredUsage } from "./usage";

export const CODEX_EXTERNAL_SANDBOX_FLAG = "--dangerously-bypass-approvals-and-sandbox";
export const CODEX_SANDBOX_MODE = "danger-full-access";

export interface CodexRunnerOptions {
  /** User-supplied Codex credential resolved by getCodexCredentialForUser. */
  credential?: CodexCredential;
  /** Resolve after nonsecret sandbox setup, immediately before credential delivery. */
  loadCredential?: () => Promise<CodexCredential>;
  /** Required for ChatGPT subscription auth so the runner can persist refreshed auth.json. */
  chatGptAuthStore?: CodexChatGptAuthStore;
  /** Model identifier (e.g. "gpt-5.6-sol"). */
  model?: string;
  /** Reasoning effort passed to Codex. */
  effort?: AgentEffort;
}

/**
 * Codex CLI agent runner.
 *
 * Runs `codex exec` inside a per-session sandbox. API keys and Codex access
 * tokens are injected only into the process environment. ChatGPT subscription
 * auth writes the saved Codex auth.json before the run and persists any
 * refreshed auth cache after the CLI exits. Streams stdout line-by-line as
 * AgentEvents.
 *
 * Expects `codex` on PATH inside the sandbox (installed at sandbox boot).
 */
export class CodexRunner implements AgentRunner {
  readonly provider = "codex";
  readonly requiresSandbox = true;

  constructor(private readonly options: CodexRunnerOptions) {
    if (!options.loadCredential && !options.credential?.secret) {
      throw new Error("CodexRunner requires a Codex credential.");
    }
  }

  start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const safety = new AgentOutputSafety(input.secrets, input.onSensitiveValue);
    return safety.events(this.startUnsafe(input, safety), input.signal);
  }

  private async *startUnsafe(
    input: AgentRunnerStartInput,
    safety: AgentOutputSafety,
  ): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    if (!sandbox) {
      throw new Error("CodexRunner requires a sandbox.");
    }

    const model = this.options.model ?? DEFAULT_CODEX_MODEL;
    const effort = this.options.effort ?? DEFAULT_CODEX_REASONING_EFFORT;
    const directory = await prepareRunnerDirectory(this.provider, sandbox, input.signal);
    const promptFile = `${directory}/prompt.txt`;
    const finalOutputFile = `${directory}/final-output.md`;
    const codexHome = `${directory}/codex`;

    await sandbox.writeFile(promptFile, input.prompt, { mode: 0o600 });
    input.signal?.throwIfAborted();
    if (this.options.loadCredential || this.options.credential?.type !== "codex_access_token") {
      await ensureCodexHome(sandbox, codexHome, safety);
    }

    // All nonsecret remote setup precedes the current authorization read.
    // The next remote operation sends this credential, without another setup await.
    input.signal?.throwIfAborted();
    const credential = this.options.loadCredential
      ? await this.options.loadCredential()
      : this.options.credential;
    if (!credential?.secret) throw new Error("CodexRunner requires a Codex credential.");
    safety.addSecret(credential.secret);
    input.signal?.throwIfAborted();
    if (credential.type === "chatgpt_auth_json") {
      const store = this.options.chatGptAuthStore;
      if (!store) {
        throw new Error("CodexRunner requires a ChatGPT auth store for subscription auth.");
      }
      // Pipeline loaders already return fresh authorized auth. Eager callers
      // retain the store reload, now after prompt/home preparation as well.
      const currentCredential = this.options.loadCredential
        ? credential
        : await store.loadChatGptAuth({ userId: credential.userId });
      safety.addSecret(currentCredential.secret);
      input.signal?.throwIfAborted();
      yield* this.runWithChatGptAuth(
        input,
        currentCredential,
        store,
        { codexHome, promptFile, finalOutputFile },
        safety,
      );
      return;
    }

    const shellCmd = codexCommandForCredential(
      model,
      effort,
      credential,
      codexHome,
      promptFile,
      sandbox.repoPath,
      finalOutputFile,
    );

    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: {
        CI: "1",
        CODEX_HOME: codexHome,
        ...WALLIE_GIT_IDENTITY_ENV,
        ...codexCredentialEnv(credential),
      },
      signal: input.signal,
    });

    const errors: string[] = [];
    const tools = new ToolEventTracker();
    let lastMessage: string | undefined;
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
        for (const event of trackedCodexLine(line, tools)) {
          if (event.type === "error") errors.push(event.message);
          else {
            if (event.type === "progress") lastMessage = event.text;
            yield event;
          }
        }
      }
    }

    if (stdoutBuf.trim()) {
      for (const event of trackedCodexLine(stdoutBuf, tools)) {
        if (event.type === "error") errors.push(event.message);
        else {
          if (event.type === "progress") lastMessage = event.text;
          yield event;
        }
      }
    }

    yield* tools.gaps();
    const code = await proc.exitCode;
    const stderr = safety.redact(stderrBuf);
    if (code !== 0) errors.push(codexExitErrorMessage(code, stderr));

    yield* codexSessionCompletion(
      sandbox,
      finalOutputFile,
      errors,
      lastMessage,
      code !== 0 && redactRunSensitiveText(stderr).length > 500,
    );
  }

  private async *runWithChatGptAuth(
    input: AgentRunnerStartInput,
    credential: ChatGptCodexCredential,
    store: CodexChatGptAuthStore,
    paths: { codexHome: string; promptFile: string; finalOutputFile: string },
    safety: AgentOutputSafety,
  ): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    if (!sandbox) return;

    const model = this.options.model ?? DEFAULT_CODEX_MODEL;
    const effort = this.options.effort ?? DEFAULT_CODEX_REASONING_EFFORT;
    const { codexHome, promptFile, finalOutputFile } = paths;
    const codexAuthFile = `${codexHome}/auth.json`;
    await sandbox.writeFile(codexAuthFile, credential.secret, { mode: 0o600 });
    input.signal?.throwIfAborted();
    input.onCheckpointSensitiveValues?.(async (signal) => {
      signal.throwIfAborted();
      try {
        // Codex can refresh this file before the post-exit credential sync runs.
        const authJson = await sandbox.readFile(codexAuthFile);
        signal.throwIfAborted();
        if (!authJson) throw new Error("Missing Codex auth cache.");
        parseCodexChatGptAuthJson(authJson);
        const values: string[] = [];
        new AgentOutputSafety(undefined, (value) => values.push(value)).addSecret(authJson);
        return values;
      } catch {
        signal.throwIfAborted();
        throw new Error("Could not verify current Codex credentials for the Retry checkpoint.");
      }
    });

    const proc = await sandbox.exec(
      "bash",
      ["-lc", codexExecCommand(model, effort, promptFile, sandbox.repoPath, finalOutputFile)],
      {
        cwd: sandbox.repoPath,
        env: { CI: "1", CODEX_HOME: codexHome, ...WALLIE_GIT_IDENTITY_ENV },
        signal: input.signal,
      },
    );

    const errors: string[] = [];
    const tools = new ToolEventTracker();
    let lastMessage: string | undefined;
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
        for (const event of trackedCodexLine(line, tools)) {
          if (event.type === "error") errors.push(event.message);
          else {
            if (event.type === "progress") lastMessage = event.text;
            yield event;
          }
        }
      }
    }

    if (stdoutBuf.trim()) {
      for (const event of trackedCodexLine(stdoutBuf, tools)) {
        if (event.type === "error") errors.push(event.message);
        else {
          if (event.type === "progress") lastMessage = event.text;
          yield event;
        }
      }
    }

    yield* tools.gaps();
    const code = await proc.exitCode;
    const stderr = safety.redact(stderrBuf);
    const errorMessage = code === 0 ? null : codexExitErrorMessage(code, stderr);
    const authenticationFailed =
      code !== 0 && isAuthFailure(`codex CLI exited with code ${code}: ${stderr.slice(0, 500)}`);
    if (authenticationFailed) {
      await store.markChatGptAuthReconnectRequired({
        previousCredentialGeneration: credential.credentialGeneration,
        previousCredentialVersion: credential.credentialVersion,
        reason: "The saved ChatGPT Codex sign-in is no longer valid. Reconnect Codex in Settings.",
        userId: credential.userId,
      });
    } else {
      await persistRefreshedChatGptAuthJson({
        credential,
        sandbox,
        store,
        authFile: codexAuthFile,
        safety,
      });
    }

    if (errorMessage) errors.push(errorMessage);

    yield* codexSessionCompletion(
      sandbox,
      finalOutputFile,
      errors,
      lastMessage,
      code !== 0 && redactRunSensitiveText(stderr).length > 500,
    );
  }
}

/** Retain the legacy parser assertion shape; the runner consumes every parsed event. */
export function parseCodexLine(raw: string): AgentEvent | null {
  return parseCodexStreamLine(raw)[0] ?? null;
}

/** Parse exec JSONL without retaining provider metadata or unsupported content. */
export function parseCodexStreamLine(raw: string): AgentEvent[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    if (trimmed.startsWith("{") || /^\[\s*(?:[{"\d-]|true\b|false\b|null\b|\]|$)/.test(trimmed)) {
      return [{ type: "capture_gap", reason: "unsupported_event" }];
    }
    return [{ type: "progress", text: trimmed }];
  }
  if (!isRecord(obj)) return [{ type: "capture_gap", reason: "unsupported_event" }];

  if (
    (obj.type === "item.started" || obj.type === "item.updated" || obj.type === "item.completed") &&
    isRecord(obj.item)
  ) {
    if (obj.item.type === "command_execution" || obj.item.type === "mcp_tool_call") {
      return parseCodexToolItem(obj.type, obj.item);
    }
    if (obj.type !== "item.completed") return [];
    const event = parseCodexItem(obj.item);
    return event ? [event] : [];
  }

  const event = parseCodexControl(obj);
  return event ? [event] : [];
}

function trackedCodexLine(raw: string, tools: ToolEventTracker): AgentEvent[] {
  const parsed = parseCodexStreamLine(raw);
  const tracked = parsed.flatMap((event): AgentEvent[] => {
    if (event.type === "tool_use") return tools.start(event);
    if (event.type === "tool_result") return tools.finish(event);
    // Native turn notifications report usage before the authoritative file is read.
    if (event.type === "completion")
      return event.usage
        ? [{ type: "usage", usage: event.usage, sourceRecoveryRequired: true }]
        : [];
    return [event];
  });
  const hasResult = (event: AgentEvent) => event.type === "tool_result";
  if (parsed.some(hasResult) && !tracked.some(hasResult)) {
    return tracked.filter((event) => event.type !== "capture_gap");
  }
  return tracked;
}

function parseCodexControl(obj: Record<string, unknown>): AgentEvent | null {
  if (obj.type === "text" && typeof obj.text === "string") {
    return { type: "progress", text: obj.text };
  }
  if (obj.type === "message" && typeof obj.content === "string") {
    return { type: "progress", text: obj.content };
  }
  if (obj.type === "tool_call" && typeof obj.name === "string") {
    return {
      type: "tool_use",
      tool: obj.name,
      input: codexToolText(obj.arguments ?? {}),
      ...(typeof obj.call_id === "string" && obj.call_id ? { callId: obj.call_id } : {}),
    };
  }
  if (obj.type === "turn.failed" || obj.type === "error") {
    const message =
      typeof obj.message === "string"
        ? obj.message
        : isRecord(obj.error) && typeof obj.error.message === "string"
          ? obj.error.message
          : "Codex reported a failed turn.";
    return { type: "error", message };
  }
  if (obj.type === "turn.completed" || obj.type === "result") {
    const summary =
      obj.type === "turn.completed"
        ? "Codex turn completed"
        : typeof obj.summary === "string"
          ? obj.summary
          : typeof obj.result === "string"
            ? obj.result
            : "Codex run finished";
    const event: AgentEvent = { type: "completion", taskComplete: true, summary };
    const usage = parseCodexUsage(obj.usage);
    if (usage) event.usage = usage;
    return event;
  }
  if (obj.type === "thread.started" || obj.type === "turn.started") return null;
  return { type: "capture_gap", reason: "unsupported_event" };
}

function parseCodexItem(item: Record<string, unknown>): AgentEvent | null {
  if (item.type === "agent_message") {
    const text = textFromCodexContent(item.text ?? item.content);
    return text ? { type: "progress", text } : null;
  }
  if (
    (item.type === "tool_call" || item.type === "function_call") &&
    typeof item.name === "string"
  ) {
    return {
      type: "tool_use",
      tool: item.name,
      input: codexToolText(item.arguments ?? item.input ?? {}),
      ...(typeof item.id === "string" && item.id ? { callId: item.id } : {}),
    };
  }
  if (
    typeof item.type === "string" &&
    Object.keys(item).some((key) => key !== "id" && key !== "type")
  ) {
    return { type: "capture_gap", reason: "unsupported_event" };
  }
  return null;
}

function codexToolText(value: unknown): string {
  return redactRunToolText(typeof value === "string" ? value : JSON.stringify(value));
}

// Wire fields verified against openai/codex exec_events.rs and sdk/typescript/src/items.ts.
function parseCodexToolItem(
  phase: "item.started" | "item.updated" | "item.completed",
  item: Record<string, unknown>,
): AgentEvent[] {
  if (phase === "item.updated") return [];
  const call = typeof item.id === "string" && item.id ? { callId: item.id } : {};
  const status = item.status;
  const command = item.type === "command_execution";
  if (
    status !== "in_progress" &&
    status !== "completed" &&
    status !== "failed" &&
    !(command && status === "declined")
  ) {
    return [{ type: "capture_gap", reason: "unsupported_event" }];
  }
  const events: AgentEvent[] = [];
  const namedMcp =
    typeof item.server === "string" &&
    !!item.server &&
    typeof item.tool === "string" &&
    !!item.tool;
  const tool = command
    ? "command_execution"
    : namedMcp
      ? `mcp:${item.server}/${item.tool}`
      : "mcp_tool_call";
  const hasInput = command
    ? typeof item.command === "string"
    : namedMcp && Object.hasOwn(item, "arguments");
  if (hasInput) {
    events.push({
      type: "tool_use",
      tool,
      input: codexToolText(command ? item.command : item.arguments),
      ...call,
    });
  }
  if (phase === "item.started") {
    return events.length ? events : [{ type: "capture_gap", reason: "unsupported_event" }];
  }
  if (status === "in_progress") {
    if (!call.callId) events.push({ type: "capture_gap", reason: "missing_tool_result" });

    return events;
  }
  if (command && typeof item.aggregated_output === "string") {
    events.push({
      type: "tool_result",
      tool,
      output: codexToolText(item.aggregated_output),
      ...(typeof item.exit_code === "number" && Number.isInteger(item.exit_code)
        ? { exitCode: item.exit_code }
        : {}),
      status:
        status === "completed" && !(typeof item.exit_code === "number" && item.exit_code !== 0)
          ? "success"
          : "error",
      ...call,
    });
    return events;
  }
  if (!command) {
    const error =
      isRecord(item.error) && typeof item.error.message === "string"
        ? item.error.message
        : undefined;
    if (error !== undefined) {
      events.push({
        type: "tool_result",
        tool,
        output: codexToolText(error),
        status: "error",
        ...call,
      });
      return events;
    }
    if (isRecord(item.result)) {
      const content = item.result.content;
      const text: string[] = [];
      let unsupported =
        item.result.structured_content != null ||
        item.result._meta != null ||
        item.result.meta != null;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (isRecord(block) && block.type === "text" && typeof block.text === "string")
            text.push(block.text);
          else unsupported = true;
        }
        if (text.length || (!content.length && !unsupported)) {
          if (unsupported)
            events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
          events.push({
            type: "tool_result",
            tool,
            output: codexToolText(text.join("\n")),
            status: status === "completed" ? "success" : "error",
            ...(unsupported ? { captureTruncated: true } : {}),
            ...call,
          });
          return events;
        }
      }
      events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
    }
  }
  if (!call.callId) events.push({ type: "capture_gap", reason: "missing_tool_result" });

  return events;
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

function parseCodexUsage(usage: unknown) {
  if (!isRecord(usage)) return undefined;
  return normalizeMeasuredUsage(usage.input_tokens, usage.output_tokens);
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

function codexCommandForCredential(
  model: string,
  effort: AgentEffort,
  credential: CodexCredential,
  codexHome: string,
  promptFile: string,
  sandboxRepoPath: string,
  finalOutputFile: string,
): string {
  if (credential.type !== "codex_access_token") {
    return codexExecCommand(model, effort, promptFile, sandboxRepoPath, finalOutputFile);
  }

  const loginCommand = [
    `mkdir -p ${shellQuote(codexHome)}`,
    `printf '%s' "$CODEX_ACCESS_TOKEN" | codex login --with-access-token -c ${shellQuote(
      `cli_auth_credentials_store="file"`,
    )} >/dev/stderr`,
  ].join(" && ");
  return `${loginCommand} && ${codexExecCommand(model, effort, promptFile, sandboxRepoPath, finalOutputFile)}`;
}

async function persistRefreshedChatGptAuthJson(input: {
  credential: ChatGptCodexCredential;
  authFile: string;
  safety: AgentOutputSafety;
  sandbox: NonNullable<AgentRunnerStartInput["sandbox"]>;
  store: CodexChatGptAuthStore;
}) {
  const refreshedAuthJson = await input.sandbox.readFile(input.authFile);
  if (!refreshedAuthJson || refreshedAuthJson === input.credential.secret) return;

  input.safety.addSecret(refreshedAuthJson);
  const metadata = parseCodexChatGptAuthJson(refreshedAuthJson);
  await input.store.persistChatGptAuthJson({
    authJson: refreshedAuthJson,
    metadata,
    previousCredentialGeneration: input.credential.credentialGeneration,
    previousCredentialVersion: input.credential.credentialVersion,
    userId: input.credential.userId,
  });
}

export function codexExecArgs(
  model: string,
  sandboxRepoPath: string,
  effort: AgentEffort = DEFAULT_CODEX_REASONING_EFFORT,
  finalOutputFile?: string,
): string[] {
  return [
    "exec",
    "--model",
    model,
    "--sandbox",
    CODEX_SANDBOX_MODE,
    "-c",
    `model_reasoning_effort="${effort}"`,
    "-c",
    `cli_auth_credentials_store="file"`,
    "-c",
    "mcp_servers={}",
    "-c",
    "apps.github.enabled=false",
    "--ignore-user-config",
    CODEX_EXTERNAL_SANDBOX_FLAG,
    "--cd",
    sandboxRepoPath,
    "--json",
    ...(finalOutputFile ? ["--output-last-message", finalOutputFile] : []),
    "-",
  ];
}

function codexExecCommand(
  model: string,
  effort: AgentEffort,
  promptFile: string,
  sandboxRepoPath: string,
  finalOutputFile: string,
): string {
  return `codex ${codexExecArgs(model, sandboxRepoPath, effort, finalOutputFile).map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
}

async function* codexSessionCompletion(
  sandbox: NonNullable<AgentRunnerStartInput["sandbox"]>,
  finalOutputFile: string,
  errors: readonly string[],
  lastMessage: string | undefined,
  captureTruncated: boolean,
): AsyncIterable<AgentEvent> {
  let finalOutput: string | null;
  try {
    finalOutput = await sandbox.readFile(finalOutputFile);
  } catch (error) {
    if (!errors.length) throw error;
    yield {
      type: "error",
      message: [
        ...errors,
        `Could not read Codex final output: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n\n"),
      ...(captureTruncated ? { captureTruncated: true } : {}),
    };
    return;
  }
  if (errors.length) {
    // The consumer stops on error. Retain file-only validation/blockers first,
    // while terminal usage has already flowed through from the JSON stream.
    if (finalOutput?.trim() && finalOutput !== lastMessage) {
      yield { type: "progress", text: finalOutput };
    }
    yield {
      type: "error",
      message: errors.join("\n\n"),
      ...(captureTruncated ? { captureTruncated: true } : {}),
    };
    return;
  }
  if (!finalOutput?.trim()) {
    yield {
      type: "error",
      message:
        "Codex completed without a final deliverable. Progress remains available in Run history.",
    };
    return;
  }
  yield {
    type: "completion",
    taskComplete: true,
    summary: "Codex session completed",
    finalOutput,
  };
}

async function ensureCodexHome(
  sandbox: NonNullable<AgentRunnerStartInput["sandbox"]>,
  codexHome: string,
  safety: AgentOutputSafety,
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
    throw new Error(
      `Failed to create Codex auth directory: ${redactRunSensitiveText(safety.redact(stderr)).slice(0, 500)}`,
    );
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
  const excerpt = redactRunSensitiveText(stderr).slice(0, 500);
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
  return /(?:^|\n)\s*bwrap:\s*No permissions to create a new namespace\b/i.test(stderr);
}
