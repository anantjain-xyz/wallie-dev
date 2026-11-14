import type { ClaudeCodeCredential } from "@/lib/claude-code/contracts";
import type {
  AgentEvent,
  AgentEventToolResult,
  AgentEventToolUse,
  AgentRunner,
  AgentRunnerStartInput,
} from "./types";
import { redactRunSensitiveText } from "./redact-sensitive-text";
import { AgentOutputSafety, prepareRunnerDirectory } from "./safety";
import { ToolEventTracker } from "./tool-event-tracker";
import {
  DEFAULT_AGENT_RUNNER_CONFIG,
  DEFAULT_CLAUDE_CODE_EFFORT,
  DEFAULT_CLAUDE_CODE_MODEL,
} from "./types";
import type { AgentEffort } from "@/lib/agent-config/contracts";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import { shellQuote } from "@/lib/sandbox/command";
import { isTokenCount, normalizeMeasuredUsage } from "./usage";

export interface ClaudeCodeRunnerOptions {
  /** Pre-resolved credentials; session callers use loadCredential. */
  credential?: ClaudeCodeCredential;
  /** Session credentials are loaded after remote setup, immediately before launch. */
  loadCredential?: () => Promise<ClaudeCodeCredential>;
  /** Model identifier or Claude Code alias, e.g. "claude-opus-4-8[1m]". */
  model?: string;
  /** Reasoning effort passed to Claude Code. */
  effort?: AgentEffort;
  /** Agentic turns allowed within this invocation (including tool round trips). */
  maxTurns?: number;
}

/**
 * Claude Code CLI agent runner.
 *
 * Runs `claude` inside a per-session sandbox, streams its JSON output as
 * AgentEvents. Auth is provided only through ANTHROPIC_API_KEY for the
 * subprocess; Wallie does not run `claude auth`. Expects `claude` to be on
 * PATH inside the sandbox (installed at sandbox boot by `createSessionSandbox`).
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly provider = "claude-code";
  readonly requiresSandbox = true;

  constructor(private readonly options: ClaudeCodeRunnerOptions) {
    if (!options.loadCredential && !options.credential?.secret) {
      throw new Error("ClaudeCodeRunner requires an Anthropic API key.");
    }
    if (
      options.maxTurns !== undefined &&
      (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1)
    ) {
      throw new Error("Claude Code maxTurns must be a positive integer.");
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
      throw new Error("ClaudeCodeRunner requires a sandbox.");
    }

    // Vercel Sandbox's runCommand has no stdin support; materialise the prompt
    // as a file and pipe it via bash redirection.
    const directory = await prepareRunnerDirectory(this.provider, sandbox, input.signal);
    const promptFile = `${directory}/prompt.txt`;
    await sandbox.writeFile(promptFile, input.prompt, { mode: 0o600 });

    const model = this.options.model ?? DEFAULT_CLAUDE_CODE_MODEL;
    const effort = this.options.effort ?? DEFAULT_CLAUDE_CODE_EFFORT;
    const cliArgs = [
      "--print",
      "--model",
      model,
      "--effort",
      effort,
      "--bare",
      "--add-dir",
      sandbox.repoPath,
      "--no-chrome",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--max-turns",
      String(this.options.maxTurns ?? DEFAULT_AGENT_RUNNER_CONFIG.maxTurns),
      "--verbose",
    ];
    if (input.continueSessionId) {
      cliArgs.push("--resume", input.continueSessionId);
    }

    const shellCmd = `claude ${cliArgs.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;

    input.signal?.throwIfAborted();
    const credential = this.options.loadCredential
      ? await this.options.loadCredential()
      : this.options.credential;
    if (!credential?.secret) throw new Error("ClaudeCodeRunner requires an Anthropic API key.");
    safety.addSecret(credential.secret);
    input.signal?.throwIfAborted();

    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: {
        ANTHROPIC_API_KEY: credential.secret,
        CI: "1",
        ...WALLIE_GIT_IDENTITY_ENV,
      },
      signal: input.signal,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let completion: Extract<AgentEvent, { type: "completion" }> | undefined;
    let hadError = false;
    let bufferedUsageForwarded = false;
    const tools = new ClaudeToolCapture();
    function* eventsForLine(line: string): Iterable<AgentEvent> {
      for (const event of parseStreamJsonLine(line, tools)) {
        // Success is provisional until the process also exits successfully.
        if (event.type === "completion" && event.taskComplete) {
          completion = event;
          bufferedUsageForwarded = false;
        } else {
          if (event.type === "completion" && event.usage) bufferedUsageForwarded = true;
          if (event.type === "error") {
            hadError = true;
            if (completion?.finalOutput?.trim()) {
              yield { type: "progress", text: completion.finalOutput };
            }
            if (completion?.usage && !bufferedUsageForwarded) {
              yield {
                type: "completion",
                taskComplete: false,
                summary: "Claude Code reported usage before an unsuccessful result",
                usage: completion.usage,
              };
            }
            completion = undefined;
            yield* tools.gaps();
          }
          yield event;
        }
      }
    }

    for await (const log of proc.logs()) {
      input.signal?.throwIfAborted();
      if (log.stream === "stderr") {
        stderrBuf += log.data;
        continue;
      }

      stdoutBuf += log.data;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        yield* eventsForLine(trimmed);
      }
    }

    // Flush the final partial line.
    if (stdoutBuf.trim()) {
      const trimmed = stdoutBuf.trim();
      yield* eventsForLine(trimmed);
    }

    const code = await proc.exitCode;
    input.signal?.throwIfAborted();
    yield* tools.gaps();
    if (code !== 0) {
      if (completion?.finalOutput?.trim()) {
        yield { type: "progress", text: completion.finalOutput };
      }
      if (completion?.usage) {
        yield {
          type: "completion",
          usage: completion.usage,
          taskComplete: false,
          summary: "Claude Code reported usage before a nonzero exit",
        };
      }
      const redactedStderr = redactRunSensitiveText(safety.redact(stderrBuf));
      yield {
        type: "error",
        message: `claude CLI exited with code ${code}: ${redactedStderr.slice(0, 500)}`,
        ...(redactedStderr.length > 500 ? { captureTruncated: true } : {}),
      };
      return;
    }
    if (hadError) return;
    if (completion) yield completion;
    else yield { type: "error", message: "Claude Code ended without a successful result." };
  }
}

class ClaudeToolCapture {
  private readonly tracker = new ToolEventTracker();
  private readonly partialCalls = new Set<string>();
  private reportedGaps = false;

  partial(event: Record<string, unknown>): void {
    const block = isRecord(event.content_block) ? event.content_block : undefined;
    if (event.type === "content_block_start" && block?.type === "tool_use") {
      const id = callIdentity(block.id);
      if (id) this.partialCalls.add(id);
    }
  }

  start(event: AgentEventToolUse): AgentEvent[] {
    if (event.callId) this.partialCalls.delete(event.callId);
    return this.tracker.start(event);
  }

  finish(event: AgentEventToolResult): AgentEvent[] {
    return this.tracker.finish(event);
  }

  gaps(): AgentEvent[] {
    if (this.reportedGaps) return [];
    this.reportedGaps = true;
    return [
      ...Array.from(
        this.partialCalls,
        (callId): AgentEvent => ({
          type: "capture_gap",
          reason: "unsupported_event",
          callId,
        }),
      ),
      ...this.tracker.gaps(),
    ];
  }
}

const CLAUDE_STREAM_FRAMING = new Set([
  "message_start",
  "message_delta",
  "message_stop",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "ping",
]);

/**
 * Parse a single JSON line from Claude Code's stream-json output format.
 * Preserve every content block in order. A result is successful only when the
 * CLI's terminal subtype says so; text alone is not a completed task.
 */
export function parseStreamJsonLine(line: string, tools?: ClaudeToolCapture): AgentEvent[] {
  try {
    const obj: unknown = JSON.parse(line);
    if (!isRecord(obj)) return [{ type: "capture_gap", reason: "unsupported_event" }];
    const message = isRecord(obj.message) ? obj.message : undefined;

    if (obj.type === "stream_event") {
      // The SDK repeats each finished block as an assistant message before its
      // content_block_stop. Use that authoritative block, not partial tool JSON.
      if (
        !isRecord(obj.event) ||
        typeof obj.event.type !== "string" ||
        !CLAUDE_STREAM_FRAMING.has(obj.event.type)
      ) {
        return [{ type: "capture_gap", reason: "unsupported_event" }];
      }
      tools?.partial(obj.event);
      return [];
    }

    if (obj.type === "assistant" && message?.content) {
      const content = message.content;
      if (Array.isArray(content)) {
        const events: AgentEvent[] = [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            events.push({ type: "progress", text: block.text });
          }
          if (block.type === "tool_use") {
            const callId = callIdentity(block.id);
            const event: AgentEventToolUse = {
              type: "tool_use",
              tool: typeof block.name === "string" ? block.name : "unknown",
              input:
                typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
              ...(callId ? { callId } : {}),
            };
            events.push(...(tools ? tools.start(event) : [event]));
          }
          if (
            typeof block.type === "string" &&
            block.type !== "text" &&
            block.type !== "tool_use" &&
            Object.keys(block).some((key) => key !== "type")
          ) {
            events.push({ type: "capture_gap", reason: "unsupported_event" });
          }
        }
        return events;
      }
    }

    if (obj.type === "user" && Array.isArray(message?.content)) {
      return message.content.flatMap((block: unknown): AgentEvent[] => {
        if (!isRecord(block) || block.type !== "tool_result") return [];
        if (block.is_error !== undefined && typeof block.is_error !== "boolean") {
          return [{ type: "capture_gap", reason: "unsupported_event" }];
        }
        const content = toolResultText(block.content);
        const callId = callIdentity(block.tool_use_id);
        const result: AgentEventToolResult = {
          type: "tool_result",
          tool: "unknown",
          output: content.text,
          status: block.is_error === true ? "error" : "success",
          ...(callId ? { callId } : {}),
          ...(content.unsupported ? { captureTruncated: true } : {}),
        };
        const events = tools ? tools.finish(result) : [result];
        if (content.unsupported && events.length) {
          events.unshift({
            type: "capture_gap",
            reason: "unsupported_event",
            ...(callId ? { callId } : {}),
          });
        }
        return events;
      });
    }

    if (obj.type === "result") {
      const usage = parseClaudeResultUsage(obj);
      if (obj.is_error === true || obj.subtype !== "success") {
        const details = Array.isArray(obj.errors)
          ? obj.errors.filter((error: unknown) => typeof error === "string").join("; ")
          : "";
        const error: AgentEvent = {
          type: "error",
          message: `Claude Code ${typeof obj.subtype === "string" ? obj.subtype : "unsuccessful result"}: ${details || (typeof obj.result === "string" ? obj.result : "task did not complete")}`,
        };
        const partialOutput: AgentEvent[] =
          details && typeof obj.result === "string" && obj.result.trim()
            ? [{ type: "progress", text: obj.result }]
            : [];
        if (!usage) return [...partialOutput, error];
        return [
          ...partialOutput,
          {
            type: "completion",
            taskComplete: false,
            summary: "Claude Code result was unsuccessful",
            usage,
          },
          error,
        ];
      }
      const finalOutput = typeof obj.result === "string" ? obj.result : undefined;
      return [
        {
          type: "completion",
          taskComplete: true,
          summary: finalOutput ?? "Claude Code session completed",
          finalOutput,
          ...(usage ? { usage } : {}),
        },
      ];
    }

    if (
      obj.type === "content_block_delta" &&
      isRecord(obj.delta) &&
      typeof obj.delta.text === "string"
    ) {
      return [{ type: "progress", text: obj.delta.text }];
    }

    if (
      obj.type === "system" ||
      (typeof obj.type === "string" && CLAUDE_STREAM_FRAMING.has(obj.type))
    ) {
      tools?.partial(obj);
      return [];
    }
    return Object.keys(obj).some((key) => key !== "type")
      ? [{ type: "capture_gap", reason: "unsupported_event" }]
      : [];
  } catch {
    if (/^[\[{]/u.test(line.trim())) {
      return [{ type: "capture_gap", reason: "unsupported_event" }];
    }
    if (line.length > 0) {
      return [{ type: "progress", text: line }];
    }
    return [];
  }
}

function callIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toolResultText(content: unknown): { text: string; unsupported: boolean } {
  if (content === undefined) return { text: "", unsupported: false };
  if (typeof content === "string") return { text: content, unsupported: false };
  if (!Array.isArray(content)) return { text: "", unsupported: true };
  const text: string[] = [];
  let unsupported = false;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
    } else {
      unsupported = true;
    }
  }
  return { text: text.join("\n"), unsupported };
}

function parseClaudeResultUsage(result: Record<string, unknown>) {
  const usage = isRecord(result.usage) ? result.usage : undefined;
  if (!usage) return undefined;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  if (
    !isTokenCount(usage.input_tokens) ||
    !isTokenCount(cacheRead) ||
    !isTokenCount(cacheCreation)
  ) {
    return undefined;
  }
  const inputTokens = usage.input_tokens + cacheRead + cacheCreation;
  if (!isTokenCount(inputTokens)) return undefined;
  return normalizeMeasuredUsage(inputTokens, usage.output_tokens, result.total_cost_usd);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
