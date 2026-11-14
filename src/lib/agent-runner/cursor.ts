import type { CursorCredential } from "@/lib/cursor/contracts";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import { redactSecrets, shellQuote } from "@/lib/sandbox/command";

import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { redactRunSensitiveText, redactRunToolText } from "./redact-sensitive-text";
import { AgentOutputSafety, prepareRunnerDirectory } from "./safety";
import { ToolEventTracker } from "./tool-event-tracker";
import { DEFAULT_CURSOR_MODEL } from "./types";

export interface CursorRunnerOptions {
  /** Pre-resolved credentials; session callers use loadCredential. */
  credential?: CursorCredential;
  /** Session credentials are loaded after remote setup, immediately before launch. */
  loadCredential?: () => Promise<CursorCredential>;
  model?: string;
  onAuthenticationFailure?: (reason: string, credential: CursorCredential) => Promise<void>;
}

export class CursorRunner implements AgentRunner {
  readonly provider = "cursor";
  readonly requiresSandbox = true;

  constructor(private readonly options: CursorRunnerOptions) {
    if (!options.loadCredential && !options.credential?.secret) {
      throw new Error("CursorRunner requires a Cursor API key.");
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
    if (!input.sandbox) throw new Error("CursorRunner requires a sandbox.");
    const sandbox = input.sandbox;
    const directory = await prepareRunnerDirectory(this.provider, sandbox, input.signal);
    const promptFile = `${directory}/prompt.txt`;
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

    input.signal?.throwIfAborted();
    const credential = this.options.loadCredential
      ? await this.options.loadCredential()
      : this.options.credential;
    if (!credential?.secret) throw new Error("CursorRunner requires a Cursor API key.");
    safety.addSecret(credential.secret);
    input.signal?.throwIfAborted();

    const proc = await sandbox.exec("bash", ["-lc", command], {
      cwd: sandbox.repoPath,
      env: { CI: "1", CURSOR_API_KEY: credential.secret, ...WALLIE_GIT_IDENTITY_ENV },
      signal: input.signal,
    });

    const secrets = [credential.secret, ...(input.secrets ?? [])];
    let stdout = "";
    let stderr = "";
    let completion: Extract<AgentEvent, { type: "completion" }> | undefined;
    let hadError = false;
    const tools = new ToolEventTracker();
    function* eventsForLine(line: string): Iterable<AgentEvent> {
      const parsed = parseCursorStreamJsonLine(line, secrets).events;
      const tracked = parsed.flatMap((event): AgentEvent[] => {
        if (event.type === "tool_use") return tools.start(event);
        if (event.type === "tool_result") return tools.finish(event);
        return [event];
      });
      const repeatedResult =
        parsed.some((event) => event.type === "tool_result") &&
        !tracked.some((event) => event.type === "tool_result");
      for (const event of tracked) {
        if (repeatedResult && event.type === "capture_gap") continue;
        if (event.type === "completion") {
          completion = event;
          continue;
        }
        if (event.type === "error") {
          hadError = true;
          if (completion?.finalOutput?.trim()) {
            yield { type: "progress", text: completion.finalOutput };
          }
          completion = undefined;
        }
        yield event;
      }
    }
    for await (const log of proc.logs()) {
      if (log.stream === "stderr") {
        stderr += log.data;
        continue;
      }
      stdout += log.data;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        yield* eventsForLine(line);
      }
    }
    if (stdout.trim()) {
      yield* eventsForLine(stdout);
    }

    yield* tools.gaps();
    const code = await proc.exitCode;
    if (code !== 0) {
      if (completion?.finalOutput?.trim()) {
        yield { type: "progress", text: completion.finalOutput };
      }
      const redactedStderr = redactRunSensitiveText(safety.redact(stderr.trim()));
      const reason = `Cursor CLI exited with code ${code}: ${redactedStderr.slice(0, 500)}`;
      if (isCursorAuthenticationError(stderr)) {
        await this.options.onAuthenticationFailure?.(reason, credential);
      }
      yield {
        message: reason,
        type: "error",
        ...(redactedStderr.length > 500 ? { captureTruncated: true } : {}),
      };
      return;
    }
    if (hadError) return;
    if (completion) yield completion;
    else yield { type: "error", message: "Cursor ended without a result." };
  }
}

export function parseCursorStreamJsonLine(
  line: string,
  secrets: Array<string | undefined> = [],
): { events: AgentEvent[]; sessionId?: string } {
  const trimmed = line.trim();
  if (!trimmed) return { events: [] };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    if (trimmed.startsWith("{") || /^\[\s*(?:[{"\d-]|true\b|false\b|null\b|\]|$)/.test(trimmed)) {
      return { events: [{ type: "capture_gap", reason: "unsupported_event" }] };
    }
    return { events: [{ text: redactSecrets(trimmed, secrets), type: "progress" }] };
  }
  if (!isRecord(value)) return { events: [{ type: "capture_gap", reason: "unsupported_event" }] };
  const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
  if (value.type === "assistant") {
    const text = extractText(value.message ?? value.text);
    return {
      events: text ? [{ text: redactSecrets(text, secrets), type: "progress" }] : [],
      sessionId,
    };
  }
  if (value.type === "tool_call")
    return { events: parseCursorToolCallEvents(value, secrets), sessionId };
  if (value.type === "result") {
    if (value.is_error === true || (value.subtype && value.subtype !== "success")) {
      return {
        events: [
          {
            type: "error",
            message: redactSecrets(
              extractText(value.result ?? value.summary) || "Cursor result was unsuccessful",
              secrets,
            ),
          },
        ],
        sessionId,
      };
    }
    const finalOutput = redactSecrets(extractText(value.result), secrets);
    return {
      events: [
        {
          ...(finalOutput.trim() ? { finalOutput } : {}),
          summary: redactSecrets(
            extractText(value.result ?? value.summary) || "Cursor session completed",
            secrets,
          ),
          taskComplete: true,
          type: "completion",
        },
      ],
      sessionId,
    };
  }
  if (value.type === "system" || value.type === "user") return { events: [], sessionId };
  return { events: [{ type: "capture_gap", reason: "unsupported_event" }], sessionId };
}

const TOOL_CALL_KEY_SUFFIX = "ToolCall";
const MAX_TOOL_INPUT_CHARS = 4096;
const MAX_TOOL_TEXT_CHARS = 500;
const PRIVATE_TOOL_FIELDS = new Set([
  "toolCallId",
  "tool_call_id",
  "callId",
  "call_id",
  "requestId",
  "request_id",
  "sessionId",
  "session_id",
]);
const OPAQUE_TOOL_FIELDS = new Set([
  "_meta",
  "meta",
  "metadata",
  "attachments",
  "blob",
  "base64",
  "base64Data",
]);
const BULKY_TOOL_FIELDS = new Set([
  "afterFullFileContent",
  "content",
  "diffString",
  "directoryTreeRoot",
  "fileText",
  "parsingResult",
]);

// Native envelope: https://cursor.com/docs/cli/reference/output-format#tool-call-events
function parseCursorToolCallEvents(
  value: Record<string, unknown>,
  secrets: Array<string | undefined>,
): AgentEvent[] {
  const call = typeof value.call_id === "string" && value.call_id ? { callId: value.call_id } : {};
  const subtype = value.subtype;
  if (subtype !== undefined && subtype !== "started" && subtype !== "completed") {
    return [{ type: "capture_gap", reason: "unsupported_event", ...call }];
  }
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
    toolCall.args;
  const hasInput = args !== undefined;
  const events: AgentEvent[] = [];
  if (hasInput && (subtype !== "completed" || call.callId)) {
    const serialized = serializeToolValue(args, secrets, true);
    events.push({
      type: "tool_use",
      tool,
      input: serialized.text,
      ...(serialized.truncated ? { captureTruncated: true } : {}),
      ...call,
    });
  }
  if (subtype !== "completed") {
    return events.length ? events : [{ type: "capture_gap", reason: "unsupported_event", ...call }];
  }
  const result = nested?.body.result ?? functionCall?.result ?? toolCall.result;
  if (result === undefined || result === null) {
    if (!call.callId) events.push({ type: "capture_gap", reason: "missing_tool_result" });
    else if (!hasInput) events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
    return events;
  }
  if (!isRecord(result)) {
    events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
    return events;
  }
  const outcomes = (["success", "error", "rejected"] as const).filter(
    (kind) => result[kind] !== undefined && result[kind] !== null,
  );
  if (outcomes.length !== 1) {
    events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
    return events;
  }
  const outcome = outcomes[0]!;
  const payload = result[outcome];
  if (!isRecord(payload) || !Object.keys(payload).some((key) => key !== "toolCallId")) {
    events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
    return events;
  }
  if (
    outcome !== "success" &&
    !(typeof payload.message === "string" && payload.message.trim()) &&
    !(typeof payload.reason === "string" && payload.reason.trim())
  ) {
    events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
    return events;
  }
  const exitCode =
    isRecord(payload) && typeof payload.exitCode === "number" && Number.isInteger(payload.exitCode)
      ? payload.exitCode
      : undefined;
  const serialized = serializeToolValue(payload, secrets, false);
  const sourceLimited = isRecord(payload) && payload.exceededLimit === true;
  if (!serialized.retained) {
    events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
    return events;
  }
  if (serialized.omitted)
    events.push({ type: "capture_gap", reason: "unsupported_event", ...call });
  events.push({
    type: "tool_result",
    tool,
    output: serialized.text,
    status:
      outcome === "success" && (exitCode === undefined || exitCode === 0) ? "success" : "error",
    ...(outcome === "rejected" ? { outcome: "rejected" } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(serialized.truncated || sourceLimited ? { captureTruncated: true } : {}),
    ...call,
  });
  return events;
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

type ToolCapture = { truncated: boolean };

function serializeToolValue(
  value: unknown,
  secrets: Array<string | undefined>,
  omitBulkyFields: boolean,
): { text: string; truncated: boolean; retained: boolean; omitted: boolean } {
  const capture = { truncated: false };
  const compacted = compactToolValue(value, secrets, capture, omitBulkyFields);
  let retained = false;
  let omitted = false;
  const encoded = JSON.stringify(compacted, (key, nested: unknown) => {
    if (
      PRIVATE_TOOL_FIELDS.has(key) ||
      OPAQUE_TOOL_FIELDS.has(key) ||
      (isRecord(nested) && (nested.type === "image" || nested.type === "audio"))
    ) {
      capture.truncated = true;
      omitted = true;
      return undefined;
    }
    if (typeof nested === "string" || typeof nested === "number" || typeof nested === "boolean")
      retained = true;
    return nested;
  });
  const json = redactRunToolText(redactSecrets(encoded ?? "null", secrets));
  if (json.length > MAX_TOOL_INPUT_CHARS) capture.truncated = true;
  return {
    text:
      json.length <= MAX_TOOL_INPUT_CHARS
        ? json
        : `${json.slice(0, MAX_TOOL_INPUT_CHARS - 15)}…[truncated]`,
    truncated: capture.truncated,
    retained,
    omitted,
  };
}

function compactToolValue(
  value: unknown,
  secrets: Array<string | undefined>,
  capture: ToolCapture,
  omitBulkyFields: boolean,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return truncateToolText(redactRunToolText(redactSecrets(value, secrets)), capture);
  }
  if (Array.isArray(value)) {
    if (depth > 4) return value;
    if (value.length > 20) capture.truncated = true;
    return value
      .slice(0, 20)
      .map((item) => compactToolValue(item, secrets, capture, omitBulkyFields, depth + 1));
  }
  if (!isRecord(value) || depth > 4) return value;

  const compacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (omitBulkyFields && BULKY_TOOL_FIELDS.has(key)) {
      capture.truncated = true;
      continue;
    }
    compacted[key] = compactToolValue(nested, secrets, capture, omitBulkyFields, depth + 1);
  }
  return compacted;
}

function truncateToolText(value: string, capture: ToolCapture): string {
  if (value.length <= MAX_TOOL_TEXT_CHARS) return value;
  capture.truncated = true;
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
