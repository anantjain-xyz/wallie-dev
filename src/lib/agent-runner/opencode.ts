import type { OpenCodeCredential } from "@/lib/opencode/contracts";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import { redactSecrets } from "@/lib/sandbox/command";
import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { DEFAULT_OPENCODE_MODEL } from "./types";

export interface OpenCodeRunnerOptions {
  /** User-supplied OpenCode Zen API key resolved by getOpenCodeCredentialForUser. */
  credential: OpenCodeCredential;
  /** OpenCode model identifier in provider/model form. */
  model?: string;
}

export type ParsedOpenCodeLine = {
  events: AgentEvent[];
  sessionId?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
};

/**
 * OpenCode CLI runner for OpenCode Zen.
 *
 * The Zen key is materialized in an isolated XDG data directory rather than
 * passed through the process environment or command line. OpenCode emits one
 * JSON object per line in `--format json` mode; those objects are translated
 * into Wallie's provider-neutral AgentEvent contract.
 */
export class OpenCodeRunner implements AgentRunner {
  readonly provider = "opencode";
  readonly requiresSandbox = true;

  constructor(private readonly options: OpenCodeRunnerOptions) {
    if (!options.credential?.secret) {
      throw new Error("OpenCodeRunner requires an OpenCode Zen API key.");
    }
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    if (!sandbox) {
      throw new Error("OpenCodeRunner requires a sandbox.");
    }

    const token = safePathToken(input.runId ?? input.sessionId);
    const root = `/tmp/wallie-opencode-${token}`;
    const dataHome = `${root}/data`;
    const authFile = `${dataHome}/opencode/auth.json`;
    const promptFile = `${root}/prompt.txt`;

    await Promise.all([
      sandbox.writeFile(
        authFile,
        `${JSON.stringify({ opencode: { type: "api", key: this.options.credential.secret } })}\n`,
        { mode: 0o600 },
      ),
      sandbox.writeFile(promptFile, input.prompt, { mode: 0o600 }),
    ]);

    const model = this.options.model ?? DEFAULT_OPENCODE_MODEL;
    const cliArgs = ["run", "--format", "json", "--model", model];
    if (input.continueSessionId) {
      cliArgs.push("--session", input.continueSessionId);
    }

    const shellCmd = `opencode ${cliArgs.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;
    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: { CI: "1", XDG_DATA_HOME: dataHome, ...WALLIE_GIT_IDENTITY_ENV },
      signal: input.signal,
    });

    const secrets = [this.options.credential.secret, ...(input.secrets ?? [])];
    let stdoutBuf = "";
    let stderrBuf = "";
    let lastSessionId: string | undefined;
    let hadError = false;
    const usage = { inputTokens: 0, outputTokens: 0 };
    let hasUsage = false;

    const handleLine = (line: string): AgentEvent[] => {
      const parsed = parseOpenCodeLine(line, secrets);
      if (!parsed) return [];
      if (parsed.sessionId) lastSessionId = parsed.sessionId;
      if (parsed.usage) {
        usage.inputTokens += parsed.usage.inputTokens;
        usage.outputTokens += parsed.usage.outputTokens;
        hasUsage = true;
      }
      return parsed.events.map((event) => {
        if (event.type === "error") {
          hadError = true;
          return {
            ...event,
            message: redactSecrets(event.message, secrets),
          };
        }
        if (event.type === "text") {
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
    if (code !== 0) {
      yield {
        type: "error",
        message: redactSecrets(
          `opencode CLI exited with code ${code}: ${stderrBuf.trim().slice(0, 500) || "(no stderr)"}`,
          secrets,
        ),
      };
      return;
    }

    if (hadError) return;

    yield {
      type: "completion",
      taskComplete: true,
      summary: lastSessionId ? `OpenCode session: ${lastSessionId}` : "OpenCode session completed",
      ...(hasUsage ? { usage } : {}),
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
    return null;
  }
  if (!isRecord(value)) return null;

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

  const text =
    part && typeof part.text === "string"
      ? part.text
      : typeof value.text === "string"
        ? value.text
        : null;
  if (type === "text" && text && text.trim()) {
    return { events: [{ type: "text", text }], sessionId };
  }

  if (type === "tool_use") {
    const toolPart = part ?? value;
    const state = isRecord(toolPart.state) ? toolPart.state : null;
    const status = state && typeof state.status === "string" ? state.status : null;
    if (status !== "completed" && status !== "error") {
      return { events: [], sessionId };
    }
    const input = state?.input;
    return {
      events: [
        {
          type: "tool_use",
          tool: typeof toolPart.tool === "string" ? toolPart.tool : "unknown",
          input: serializeToolInput(input, secrets),
        },
      ],
      sessionId,
    };
  }

  if (type === "step_finish") {
    const tokensPart = part ?? value;
    const tokens = isRecord(tokensPart.tokens) ? tokensPart.tokens : null;
    if (!tokens) return { events: [], sessionId };
    return {
      events: [],
      sessionId,
      usage: {
        inputTokens: finiteNumber(tokens.input),
        outputTokens: finiteNumber(tokens.output),
      },
    };
  }

  if (type === "error") {
    return {
      events: [{ type: "error", message: openCodeErrorMessage(value.error ?? value.message) }],
      sessionId,
    };
  }

  return { events: [], sessionId };
}

function openCodeErrorMessage(error: unknown): string {
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
    return JSON.stringify(error);
  }
  return "OpenCode session failed.";
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function serializeToolInput(input: unknown, secrets: Array<string | undefined>): string {
  const compactInput = compactToolValue(input ?? {}, secrets);
  const json = redactSecrets(
    typeof compactInput === "string" ? compactInput : JSON.stringify(compactInput),
    secrets,
  );
  if (json.length <= MAX_TOOL_INPUT_CHARS) return json;
  return `${json.slice(0, MAX_TOOL_INPUT_CHARS - 15)}…[truncated]`;
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

function safePathToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120) || "run";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
