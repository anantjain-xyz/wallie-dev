import type { CursorCredential } from "@/lib/cursor/contracts";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import { redactSecrets } from "@/lib/sandbox/command";

import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { DEFAULT_CURSOR_MODEL } from "./types";

const PROMPT_FILE_NAME = ".wallie-cursor-prompt.txt";

export interface CursorRunnerOptions {
  credential: CursorCredential;
  model?: string;
  onAuthenticationFailure?: (reason: string) => Promise<void>;
}

export class CursorRunner implements AgentRunner {
  readonly provider = "cursor";
  readonly requiresSandbox = true;

  constructor(private readonly options: CursorRunnerOptions) {
    if (!options.credential?.secret) throw new Error("CursorRunner requires a Cursor API key.");
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    if (!input.sandbox) throw new Error("CursorRunner requires a sandbox.");
    const sandbox = input.sandbox;
    const promptFile = `${sandbox.repoPath}/${PROMPT_FILE_NAME}`;
    await sandbox.writeFile(promptFile, input.prompt, { mode: 0o600 });

    const args = [
      "-p",
      "--force",
      "--trust",
      "--workspace",
      sandbox.repoPath,
      "--output-format",
      "stream-json",
      "--model",
      this.options.model ?? DEFAULT_CURSOR_MODEL,
    ];
    if (input.continueSessionId) args.push("--resume", input.continueSessionId);
    const command = [
      'cursor_bin="$(command -v cursor-agent || true)"',
      '[ -n "$cursor_bin" ] || cursor_bin="$HOME/.local/bin/cursor-agent"',
      `"$cursor_bin" ${args.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`,
    ].join("\n");

    const proc = await sandbox.exec("bash", ["-lc", command], {
      cwd: sandbox.repoPath,
      env: { CI: "1", CURSOR_API_KEY: this.options.credential.secret, ...WALLIE_GIT_IDENTITY_ENV },
      signal: input.signal,
    });

    const secrets = [this.options.credential.secret, ...(input.secrets ?? [])];
    let stdout = "";
    let stderr = "";
    let sessionId: string | undefined;
    let sawCompletion = false;
    for await (const log of proc.logs()) {
      if (log.stream === "stderr") {
        stderr += log.data;
        continue;
      }
      stdout += log.data;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseCursorStreamJsonLine(line, secrets);
        if (parsed.sessionId) sessionId = parsed.sessionId;
        if (parsed.event?.type === "completion") sawCompletion = true;
        if (parsed.event) yield parsed.event;
      }
    }
    if (stdout.trim()) {
      const parsed = parseCursorStreamJsonLine(stdout, secrets);
      if (parsed.sessionId) sessionId = parsed.sessionId;
      if (parsed.event?.type === "completion") sawCompletion = true;
      if (parsed.event) yield parsed.event;
    }

    const code = await proc.exitCode;
    if (code !== 0) {
      const redactedStderr = redactSecrets(stderr.trim(), secrets);
      const reason = `Cursor CLI exited with code ${code}: ${redactedStderr.slice(0, 500)}`;
      if (isCursorAuthenticationError(stderr)) await this.options.onAuthenticationFailure?.(reason);
      yield { message: reason, type: "error" };
      return;
    }
    if (!sawCompletion) {
      yield {
        summary: sessionId ? `Cursor session: ${sessionId}` : "Cursor session completed",
        taskComplete: true,
        type: "completion",
      };
    }
  }
}

export function parseCursorStreamJsonLine(
  line: string,
  secrets: Array<string | undefined> = [],
): {
  event: AgentEvent | null;
  sessionId?: string;
} {
  const trimmed = line.trim();
  if (!trimmed) return { event: null };
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
    if (value.type === "assistant") {
      const text = extractText(value.message ?? value.text);
      return {
        event: text ? { text: redactSecrets(text, secrets), type: "text" } : null,
        sessionId,
      };
    }
    if (value.type === "tool_call") {
      return { event: parseCursorToolCallEvent(value, secrets), sessionId };
    }
    if (value.type === "result") {
      const finalOutput = redactSecrets(extractText(value.result), secrets).trim();
      return {
        event: {
          ...(finalOutput ? { finalOutput } : {}),
          summary: redactSecrets(
            extractText(value.result ?? value.summary) || "Cursor session completed",
            secrets,
          ),
          taskComplete: true,
          type: "completion",
        },
        sessionId,
      };
    }
    return { event: null, sessionId };
  } catch {
    return { event: { text: redactSecrets(trimmed, secrets), type: "text" } };
  }
}

const TOOL_CALL_KEY_SUFFIX = "ToolCall";
const MAX_TOOL_INPUT_CHARS = 4096;
const MAX_TOOL_TEXT_CHARS = 500;
const BULKY_TOOL_FIELDS = new Set([
  "afterFullFileContent",
  "content",
  "diffString",
  "directoryTreeRoot",
  "fileText",
  "parsingResult",
]);

function parseCursorToolCallEvent(
  value: Record<string, unknown>,
  secrets: Array<string | undefined>,
): AgentEvent {
  const toolCall = isRecord(value.tool_call) ? value.tool_call : value;
  const nested = findNestedToolCall(toolCall);
  const functionCall = isRecord(toolCall.function) ? toolCall.function : null;
  const tool =
    nested?.name ??
    (typeof functionCall?.name === "string" ? functionCall.name : null) ??
    (typeof toolCall.name === "string" ? toolCall.name : null) ??
    "tool";
  const args =
    nested?.body.args ??
    parseFunctionArguments(functionCall?.arguments) ??
    toolCall.input ??
    toolCall.args ??
    {};
  const completed = value.subtype === "completed";
  const result = completed
    ? (nested?.body.result ?? functionCall?.result ?? toolCall.result)
    : undefined;

  return {
    input: serializeToolInput(args, completed ? result : undefined, secrets),
    tool,
    type: "tool_use",
  };
}

function findNestedToolCall(toolCall: Record<string, unknown>): {
  body: Record<string, unknown>;
  name: string;
} | null {
  for (const [key, nested] of Object.entries(toolCall)) {
    if (!key.endsWith(TOOL_CALL_KEY_SUFFIX) || key.length <= TOOL_CALL_KEY_SUFFIX.length) continue;
    if (!isRecord(nested)) continue;
    return { body: nested, name: toolCallKeyToName(key) };
  }
  return null;
}

function toolCallKeyToName(key: string): string {
  return key
    .slice(0, -TOOL_CALL_KEY_SUFFIX.length)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function parseFunctionArguments(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function serializeToolInput(
  args: unknown,
  result: unknown,
  secrets: Array<string | undefined>,
): string {
  const compactArgs = compactToolValue(args, secrets);
  const payload =
    result === undefined
      ? compactArgs
      : isRecord(compactArgs)
        ? { ...compactArgs, result: compactToolResult(result, secrets) }
        : { args: compactArgs, result: compactToolResult(result, secrets) };
  const json = redactSecrets(JSON.stringify(payload ?? {}), secrets);
  if (json.length <= MAX_TOOL_INPUT_CHARS) return json;
  return `${json.slice(0, MAX_TOOL_INPUT_CHARS - 15)}…[truncated]`;
}

function compactToolResult(result: unknown, secrets: Array<string | undefined>): unknown {
  if (!isRecord(result)) return compactToolValue(result, secrets);
  if (isRecord(result.success)) return compactToolValue(result.success, secrets);
  if (isRecord(result.error)) return { error: compactToolValue(result.error, secrets) };
  if (isRecord(result.rejected)) return { rejected: compactToolValue(result.rejected, secrets) };
  return compactToolValue(result, secrets);
}

function compactToolValue(value: unknown, secrets: Array<string | undefined>, depth = 0): unknown {
  if (typeof value === "string") return truncateToolText(redactSecrets(value, secrets));
  if (Array.isArray(value)) {
    if (depth > 4) return value;
    return value.slice(0, 20).map((item) => compactToolValue(item, secrets, depth + 1));
  }
  if (!isRecord(value) || depth > 4) return value;

  const compacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (BULKY_TOOL_FIELDS.has(key)) continue;
    compacted[key] = compactToolValue(nested, secrets, depth + 1);
  }
  return compacted;
}

function truncateToolText(value: string): string {
  if (value.length <= MAX_TOOL_TEXT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_TEXT_CHARS)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  if (typeof object.text === "string") return object.text;
  if (Array.isArray(object.content)) {
    return object.content
      .map((item) => extractText(item))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isCursorAuthenticationError(stderr: string): boolean {
  return /(?:401|unauthori[sz]ed|invalid api key|authentication failed|expired api key)/i.test(
    stderr,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
