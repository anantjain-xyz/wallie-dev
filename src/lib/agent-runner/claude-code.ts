import type { ClaudeCodeCredential } from "@/lib/claude-code/contracts";
import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { AgentOutputSafety, prepareRunnerDirectory } from "./safety";
import {
  DEFAULT_AGENT_RUNNER_CONFIG,
  DEFAULT_CLAUDE_CODE_EFFORT,
  DEFAULT_CLAUDE_CODE_MODEL,
} from "./types";
import type { AgentEffort } from "@/lib/agent-config/contracts";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";
import { shellQuote } from "@/lib/sandbox/command";

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
    const safety = new AgentOutputSafety(input.secrets);
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
    function* eventsForLine(line: string): Iterable<AgentEvent> {
      for (const event of parseStreamJsonLine(line)) {
        // Success is provisional until the process also exits successfully.
        if (event.type === "completion") completion = event;
        else {
          if (event.type === "error") hadError = true;
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
    if (code !== 0) {
      yield {
        type: "error",
        message: `claude CLI exited with code ${code}: ${safety.redact(stderrBuf).slice(0, 500)}`,
      };
      return;
    }
    if (hadError) return;
    if (completion) yield completion;
    else yield { type: "error", message: "Claude Code ended without a successful result." };
  }
}

/**
 * Parse a single JSON line from Claude Code's stream-json output format.
 * Preserve every content block in order. A result is successful only when the
 * CLI's terminal subtype says so; text alone is not a completed task.
 */
export function parseStreamJsonLine(line: string): AgentEvent[] {
  try {
    const obj = JSON.parse(line);

    if (obj.type === "assistant" && obj.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        const events: AgentEvent[] = [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text) {
            events.push({ type: "text", text: block.text });
          }
          if (block.type === "tool_use") {
            events.push({
              type: "tool_use",
              tool: block.name ?? "unknown",
              input:
                typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            });
          }
        }
        return events;
      }
    }

    if (obj.type === "result") {
      if (obj.is_error === true || obj.subtype !== "success") {
        const details = Array.isArray(obj.errors)
          ? obj.errors.filter((error: unknown) => typeof error === "string").join("; ")
          : "";
        return [
          {
            type: "error",
            message: `Claude Code ${typeof obj.subtype === "string" ? obj.subtype : "unsuccessful result"}: ${details || (typeof obj.result === "string" ? obj.result : "task did not complete")}`,
          },
        ];
      }
      const finalOutput = typeof obj.result === "string" ? obj.result : undefined;
      return [
        {
          type: "completion",
          taskComplete: true,
          summary: finalOutput ?? "Claude Code session completed",
          finalOutput,
        },
      ];
    }

    if (obj.type === "content_block_delta" && typeof obj.delta?.text === "string") {
      return [{ type: "text", text: obj.delta.text }];
    }

    return [];
  } catch {
    if (line.length > 0) {
      return [{ type: "text", text: line }];
    }
    return [];
  }
}
