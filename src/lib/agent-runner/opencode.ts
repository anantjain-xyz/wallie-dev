import { OPENCODE_ZEN_PROVIDER_ID, parseOpenCodeModelId } from "@/lib/agent-config/contracts";
import type { OpenCodeCredential } from "@/lib/opencode/contracts";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import { redactSecrets, shellQuote } from "@/lib/sandbox/command";
import type { AgentEvent, AgentRunUsage, AgentRunner, AgentRunnerStartInput } from "./types";
import { redactRunSensitiveText, redactRunToolText } from "./redact-sensitive-text";
import { AgentOutputSafety, prepareRunnerDirectory } from "./safety";
import { ToolEventTracker } from "./tool-event-tracker";
import { DEFAULT_OPENCODE_MODEL } from "./types";
import { isTokenCount, normalizeMeasuredUsage } from "./usage";

export type OpenCodeRunnerAuth = {
  /** User-supplied OpenCode Zen API key, if connected. */
  credential?: OpenCodeCredential | null;
  /** Custom provider keys keyed by OpenCode provider id. Never includes `opencode`. */
  providerCredentials?: Readonly<Record<string, OpenCodeCredential>>;
};

export interface OpenCodeRunnerOptions extends OpenCodeRunnerAuth {
  /** Load current credentials immediately before writing sandbox authentication. */
  loadAuth?: () => Promise<OpenCodeRunnerAuth>;
  /** OpenCode model identifier in provider/model form. */
  model?: string;
}

export type ParsedOpenCodeLine = {
  events: AgentEvent[];
  sessionId?: string;
  messageId?: string;
  textPartId?: string;
  step?: { kind: "start" } | { kind: "finish"; reason: string };
  usage?: AgentRunUsage;
  /** A malformed step invalidates the whole run's usage, rather than a partial total. */
  usageInvalid?: boolean;
};

/**
 * OpenCode CLI runner.
 *
 * Keys are materialized in an isolated XDG data directory rather than passed
 * through the process environment or command line. `auth.json` is keyed by
 * OpenCode provider id (the segment before the first slash of `--model`).
 * OpenCode emits one JSON object per line in `--format json` mode; those
 * objects are translated into Wallie's provider-neutral AgentEvent contract.
 */
export class OpenCodeRunner implements AgentRunner {
  readonly provider = "opencode";
  readonly requiresSandbox = true;

  private readonly model: string;
  private readonly modelProviderId: string;

  constructor(private readonly options: OpenCodeRunnerOptions) {
    this.model = options.model ?? DEFAULT_OPENCODE_MODEL;
    const parsed = parseOpenCodeModelId(this.model);
    if (!parsed) {
      throw new Error(
        `OpenCodeRunner requires a "<provider-id>/<model-id>" model, got "${this.model}".`,
      );
    }
    this.modelProviderId = parsed.providerId;
    if (!options.loadAuth && !secretForProvider(options, parsed.providerId)) {
      throw missingProviderCredentialError(parsed.providerId);
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
      throw new Error("OpenCodeRunner requires a sandbox.");
    }

    const root = await prepareRunnerDirectory(this.provider, sandbox, input.signal);
    const dataHome = `${root}/data`;
    const authFile = `${dataHome}/opencode/auth.json`;
    const promptFile = `${root}/prompt.txt`;

    await sandbox.writeFile(promptFile, input.prompt, { mode: 0o600 });

    input.signal?.throwIfAborted();
    const auth = this.options.loadAuth ? await this.options.loadAuth() : this.options;
    input.signal?.throwIfAborted();
    if (!secretForProvider(auth, this.modelProviderId)) {
      throw missingProviderCredentialError(this.modelProviderId);
    }
    safety.addSecret(auth.credential?.secret);
    for (const credential of Object.values(auth.providerCredentials ?? {})) {
      safety.addSecret(credential.secret);
    }
    const authEntries = buildOpenCodeAuthEntries(auth, this.modelProviderId);
    await sandbox.writeFile(authFile, `${JSON.stringify(authEntries)}\n`, { mode: 0o600 });
    input.signal?.throwIfAborted();

    const cliArgs = ["run", "--format", "json", "--model", this.model];
    if (input.continueSessionId) {
      cliArgs.push("--session", input.continueSessionId);
    }

    const shellCmd = `opencode ${cliArgs.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: { CI: "1", XDG_DATA_HOME: dataHome, ...WALLIE_GIT_IDENTITY_ENV },
      signal: input.signal,
    });

    const secrets = [
      auth.credential?.secret,
      ...Object.values(auth.providerCredentials ?? {}).map((credential) => credential.secret),
      ...(input.secrets ?? []),
    ];
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastSessionId: string | undefined;
    let hadError = false;
    const deferredErrors: Extract<AgentEvent, { type: "error" }>[] = [];
    const usage = { inputTokens: 0, outputTokens: 0 };
    let costUsd = 0;
    let hasUsage = false;
    let usageInvalid = false;
    let hasCompleteCost = true;
    const messageText = new Map<string, Map<string, string>>();
    const tools = new ToolEventTracker();
    let lastStep: { messageId: string | undefined; reason: string | undefined } | undefined;

    const handleLine = (line: string): AgentEvent[] => {
      const parsed = parseOpenCodeLine(line, secrets);
      if (!parsed) return [];
      if (parsed.sessionId) lastSessionId = parsed.sessionId;
      if (parsed.step) {
        lastStep = {
          messageId: parsed.messageId,
          reason: parsed.step.kind === "finish" ? parsed.step.reason : undefined,
        };
      }
      if (parsed.messageId && parsed.textPartId) {
        for (const event of parsed.events) {
          if (event.type !== "progress") continue;
          let parts = messageText.get(parsed.messageId);
          if (!parts) {
            parts = new Map();
            messageText.set(parsed.messageId, parts);
          }
          parts.set(parsed.textPartId, event.text);
        }
      }
      if (parsed.usageInvalid) usageInvalid = true;
      if (parsed.usage) {
        usage.inputTokens += parsed.usage.inputTokens;
        usage.outputTokens += parsed.usage.outputTokens;
        if (!isTokenCount(usage.inputTokens) || !isTokenCount(usage.outputTokens)) {
          usageInvalid = true;
        }
        hasUsage = true;
        if (parsed.usage.costUsd === undefined) hasCompleteCost = false;
        else costUsd += parsed.usage.costUsd;
      }
      const events = parsed.events.map((event) => {
        if (event.type === "error") {
          hadError = true;
          return {
            ...event,
            message: redactSecrets(event.message, secrets),
          };
        }
        if (event.type === "text" || event.type === "progress") {
          return {
            ...event,
            text: redactSecrets(event.text, secrets),
          };
        }
        if (event.type === "tool_use") {
          return {
            ...event,
            input: redactSecrets(event.input, secrets),
          };
        }
        if (event.type === "completion") {
          return {
            ...event,
            summary: redactSecrets(event.summary, secrets),
          };
        }
        return event;
      });
      const tracked = events.flatMap((event) => {
        if (event.type === "tool_use") return tools.start(event);
        if (event.type === "tool_result") return tools.finish(event);
        if (event.type === "error") {
          deferredErrors.push(event);
          return [];
        }
        return [event];
      });
      const repeatedResult =
        events.some((event) => event.type === "tool_result") &&
        !tracked.some((event) => event.type === "tool_result");
      return repeatedResult ? tracked.filter((event) => event.type !== "capture_gap") : tracked;
    };

    for await (const log of proc.logs()) {
      if (log.stream === "stderr") {
        stderrBuf += log.data;
        continue;
      }

      stdoutBuf += log.data;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        for (const event of handleLine(line)) yield event;
      }
    }

    if (stdoutBuf.trim()) {
      for (const event of handleLine(stdoutBuf)) yield event;
    }

    const code = await proc.exitCode;
    yield* tools.gaps();
    const finalUsage =
      hasUsage && !usageInvalid
        ? normalizeMeasuredUsage(
            usage.inputTokens,
            usage.outputTokens,
            hasCompleteCost ? costUsd : undefined,
          )
        : undefined;
    if (code !== 0) {
      if (finalUsage) {
        yield {
          type: "completion",
          taskComplete: false,
          summary: "OpenCode session ended unsuccessfully",
          usage: finalUsage,
        };
      }
      yield* deferredErrors;
      const redactedStderr = redactRunSensitiveText(safety.redact(stderrBuf).trim());
      yield {
        type: "error",
        message: redactSecrets(
          `opencode CLI exited with code ${code}: ${redactedStderr.slice(0, 500) || "(no stderr)"}`,
          secrets,
        ),
        ...(redactedStderr.length > 500 ? { captureTruncated: true } : {}),
      };
      return;
    }

    if (hadError) {
      if (finalUsage) {
        yield {
          type: "completion",
          taskComplete: false,
          summary: "OpenCode session ended unsuccessfully",
          usage: finalUsage,
        };
      }
      yield* deferredErrors;
      return;
    }

    // OpenCode's JSON stream has no run-level result. Only text belonging to
    // the last completed stop step is a final deliverable; tool-step narration
    // and streams missing that boundary remain activity only.
    const finalParts =
      lastStep?.reason === "stop" && lastStep.messageId
        ? messageText.get(lastStep.messageId)
        : undefined;
    const finalOutput = finalParts ? [...finalParts.values()].join("\n") : undefined;
    yield {
      type: "completion",
      taskComplete: true,
      summary: lastSessionId ? `OpenCode session: ${lastSessionId}` : "OpenCode session completed",
      ...(finalOutput?.trim() ? { finalOutput } : {}),
      ...(finalUsage ? { usage: finalUsage } : {}),
    };
  }
}

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

export function parseOpenCodeLine(
  line: string,
  secrets: Array<string | undefined> = [],
): ParsedOpenCodeLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return { events: [{ type: "capture_gap", reason: "unsupported_event" }] };
  }
  if (!isRecord(value)) {
    return { events: [{ type: "capture_gap", reason: "unsupported_event" }] };
  }

  const part = isRecord(value.part) ? value.part : null;
  const sessionId =
    typeof value.sessionID === "string"
      ? value.sessionID
      : typeof value.sessionId === "string"
        ? value.sessionId
        : part && typeof part.sessionID === "string"
          ? part.sessionID
          : part && typeof part.sessionId === "string"
            ? part.sessionId
            : undefined;
  const type = typeof value.type === "string" ? value.type : "";
  const messageId = part && typeof part.messageID === "string" ? part.messageID : undefined;

  const text =
    part && typeof part.text === "string"
      ? part.text
      : typeof value.text === "string"
        ? value.text
        : null;
  if (type === "text" && text !== null) {
    return {
      events: text.trim() ? [{ type: "progress", text }] : [],
      sessionId,
      ...(messageId ? { messageId } : {}),
      ...(part && typeof part.id === "string" ? { textPartId: part.id } : {}),
    };
  }

  if (type === "step_start") {
    return { events: [], sessionId, messageId, step: { kind: "start" } };
  }

  if (type === "tool_use") {
    const toolPart = part ?? value;
    const state = isRecord(toolPart.state) ? toolPart.state : null;
    const tool = typeof toolPart.tool === "string" && toolPart.tool.trim() ? toolPart.tool : null;
    // Both CLI generations emit terminal snapshots; v1 uses callID, while
    // the current renderer carries the actual tool identity in id.
    const callId =
      typeof toolPart.callID === "string" && toolPart.callID
        ? toolPart.callID
        : typeof toolPart.id === "string" && toolPart.id
          ? toolPart.id
          : undefined;
    const correlation = callId ? { callId } : {};
    const unsupported: AgentEvent = {
      type: "capture_gap",
      reason: "unsupported_event",
      ...correlation,
    };
    if (!state || !tool || (state.status !== "completed" && state.status !== "error")) {
      return { events: [unsupported], sessionId };
    }
    const events: AgentEvent[] = [];
    if (isRecord(state.input)) {
      events.push({
        type: "tool_use",
        tool,
        ...correlation,
        ...serializeToolInput(state.input, secrets),
      });
    } else {
      events.push(unsupported);
    }
    const output = state.status === "completed" ? state.output : state.error;
    if (typeof output !== "string") {
      if (isRecord(state.input)) events.push(unsupported);
      if (!callId || !isRecord(state.input)) {
        events.push({ type: "capture_gap", reason: "missing_tool_result", ...correlation });
      }
      return { events, sessionId };
    }
    const truncated =
      (state.attachments !== undefined &&
        (!Array.isArray(state.attachments) || state.attachments.length > 0)) ||
      (isRecord(state.metadata) && state.metadata.truncated === true) ||
      (isRecord(state.time) && typeof state.time.compacted === "number");
    if (truncated) events.push(unsupported);
    events.push({
      type: "tool_result",
      tool,
      ...correlation,
      output: redactRunToolText(redactSecrets(output, secrets)),
      status: state.status === "completed" ? "success" : "error",
      ...(truncated ? { captureTruncated: true } : {}),
    });
    return { events, sessionId };
  }

  if (type === "step_finish") {
    const tokensPart = part ?? value;
    const step = {
      messageId,
      step: {
        kind: "finish",
        reason: typeof tokensPart.reason === "string" ? tokensPart.reason : "",
      },
    } satisfies Pick<ParsedOpenCodeLine, "messageId" | "step">;
    const tokens = isRecord(tokensPart.tokens) ? tokensPart.tokens : null;
    const cache = tokens && isRecord(tokens.cache) ? tokens.cache : null;
    const cacheRead = cache?.read ?? 0;
    const cacheWrite = cache?.write ?? 0;
    if (
      !tokens ||
      !isTokenCount(tokens.input) ||
      !isTokenCount(cacheRead) ||
      !isTokenCount(cacheWrite)
    ) {
      return { events: [], sessionId, ...step, usageInvalid: true };
    }
    const inputTokens = tokens.input + cacheRead + cacheWrite;
    if (!isTokenCount(inputTokens)) return { events: [], sessionId, ...step, usageInvalid: true };
    const usage = normalizeMeasuredUsage(inputTokens, tokens.output, tokensPart.cost);
    if (!usage) return { events: [], sessionId, ...step, usageInvalid: true };
    return { events: [], sessionId, ...step, usage };
  }

  if (type === "error") {
    const message = openCodeErrorMessage(value.error ?? value.message);
    const events: AgentEvent[] = message
      ? []
      : [{ type: "capture_gap", reason: "unsupported_event" }];
    events.push({ type: "error", message: message ?? "OpenCode session failed." });
    return {
      events,
      sessionId,
    };
  }

  return { events: [{ type: "capture_gap", reason: "unsupported_event" }], sessionId };
}

function buildOpenCodeAuthEntries(
  options: OpenCodeRunnerAuth,
  modelProviderId: string,
): Record<string, { type: "api"; key: string }> {
  const entries: Record<string, { type: "api"; key: string }> = {};
  const zenSecret = options.credential?.secret;
  if (zenSecret) {
    entries[OPENCODE_ZEN_PROVIDER_ID] = { type: "api", key: zenSecret };
  }
  if (modelProviderId !== OPENCODE_ZEN_PROVIDER_ID) {
    const providerSecret = options.providerCredentials?.[modelProviderId]?.secret;
    if (providerSecret) {
      entries[modelProviderId] = { type: "api", key: providerSecret };
    }
  }
  return entries;
}

function secretForProvider(options: OpenCodeRunnerAuth, providerId: string): string | undefined {
  if (providerId === OPENCODE_ZEN_PROVIDER_ID) {
    return options.credential?.secret || undefined;
  }
  return options.providerCredentials?.[providerId]?.secret || undefined;
}

function missingProviderCredentialError(providerId: string): Error {
  if (providerId === OPENCODE_ZEN_PROVIDER_ID) {
    return new Error("OpenCodeRunner requires an OpenCode Zen API key.");
  }
  return new Error(
    `OpenCodeRunner requires an API key for provider "${providerId}". Add it in Settings before running this model.`,
  );
}

function openCodeErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string" && error.trim()) return error;
  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message.trim()) return error.message;
    if (
      isRecord(error.data) &&
      typeof error.data.message === "string" &&
      error.data.message.trim()
    ) {
      return error.data.message;
    }
  }
  return undefined;
}

type ToolCapture = { truncated: boolean };

function serializeToolInput(
  input: unknown,
  secrets: Array<string | undefined>,
): Pick<Extract<AgentEvent, { type: "tool_use" }>, "input" | "captureTruncated"> {
  const capture = { truncated: false };
  const compactInput = compactToolValue(input ?? {}, secrets, capture);
  const json = redactRunToolText(
    redactSecrets(
      typeof compactInput === "string" ? compactInput : JSON.stringify(compactInput),
      secrets,
    ),
  );
  if (json.length > MAX_TOOL_INPUT_CHARS) capture.truncated = true;
  return {
    input:
      json.length <= MAX_TOOL_INPUT_CHARS
        ? json
        : `${json.slice(0, MAX_TOOL_INPUT_CHARS - 15)}…[truncated]`,
    ...(capture.truncated ? { captureTruncated: true } : {}),
  };
}

function compactToolValue(
  value: unknown,
  secrets: Array<string | undefined>,
  capture: ToolCapture,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    return truncateToolText(redactRunToolText(redactSecrets(value, secrets)), capture);
  }
  if (Array.isArray(value)) {
    if (depth > 4) return value;
    if (value.length > 20) capture.truncated = true;
    return value.slice(0, 20).map((item) => compactToolValue(item, secrets, capture, depth + 1));
  }
  if (!isRecord(value) || depth > 4) return value;

  const compacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (BULKY_TOOL_FIELDS.has(key)) {
      capture.truncated = true;
      continue;
    }
    compacted[key] = compactToolValue(nested, secrets, capture, depth + 1);
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
