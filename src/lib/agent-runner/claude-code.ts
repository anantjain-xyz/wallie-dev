import type { ClaudeCodeCredential } from "@/lib/claude-code/contracts";
import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { DEFAULT_CLAUDE_CODE_EFFORT, DEFAULT_CLAUDE_CODE_MODEL } from "./types";

const PROMPT_FILE_NAME = ".wallie-prompt.txt";

export interface ClaudeCodeRunnerOptions {
  /** User-supplied Anthropic API key resolved by getClaudeCodeCredentialForUser. */
  credential: ClaudeCodeCredential;
  /** Model identifier or Claude Code alias, e.g. "claude-opus-4-7[1m]". */
  model?: string;
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
    if (!options.credential?.secret) {
      throw new Error("ClaudeCodeRunner requires an Anthropic API key.");
    }
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    if (!sandbox) {
      throw new Error("ClaudeCodeRunner requires a sandbox.");
    }

    // Vercel Sandbox's runCommand has no stdin support; materialise the prompt
    // as a file and pipe it via bash redirection.
    const promptFile = `${sandbox.repoPath}/${PROMPT_FILE_NAME}`;
    await sandbox.writeFile(promptFile, input.prompt);

    const model = this.options.model ?? DEFAULT_CLAUDE_CODE_MODEL;
    const cliArgs = [
      "--print",
      "--model",
      model,
      "--effort",
      DEFAULT_CLAUDE_CODE_EFFORT,
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--max-turns",
      "1", // Single turn per invocation; multi-turn is handled by the orchestrator.
      "--verbose",
    ];
    if (input.continueSessionId) {
      cliArgs.push("--resume", input.continueSessionId);
    }

    const shellCmd = `claude ${cliArgs.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`;

    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: { ANTHROPIC_API_KEY: this.options.credential.secret, CI: "1" },
      signal: input.signal,
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let lastSessionId: string | undefined;

    for await (const log of proc.logs()) {
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

        const event = parseStreamJsonLine(trimmed);
        if (event) yield event;

        // Extract session ID from the stream for continuation across turns.
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.session_id) lastSessionId = parsed.session_id;
        } catch {
          // Not JSON — ignore.
        }
      }
    }

    // Flush the final partial line.
    if (stdoutBuf.trim()) {
      const trimmed = stdoutBuf.trim();
      const event = parseStreamJsonLine(trimmed);
      if (event) yield event;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.session_id) lastSessionId = parsed.session_id;
      } catch {
        // Not JSON — ignore.
      }
    }

    const code = await proc.exitCode;
    if (code !== 0) {
      yield {
        type: "error",
        message: `claude CLI exited with code ${code}: ${stderrBuf.slice(0, 500)}`,
      };
    }

    yield {
      type: "completion",
      taskComplete: true,
      summary: lastSessionId
        ? `Claude Code session: ${lastSessionId}`
        : "Claude Code session completed",
    };
  }
}

/**
 * Parse a single JSON line from Claude Code's stream-json output format.
 * Returns an AgentEvent or null if the line is not actionable.
 */
export function parseStreamJsonLine(line: string): AgentEvent | null {
  try {
    const obj = JSON.parse(line);

    if (obj.type === "assistant" && obj.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            return { type: "text", text: block.text };
          }
          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              tool: block.name ?? "unknown",
              input: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
            };
          }
        }
      }
    }

    if (obj.type === "result") {
      return {
        type: "completion",
        taskComplete: true,
        summary: obj.result ?? obj.summary ?? "Agent completed",
      };
    }

    if (obj.type === "content_block_delta" && obj.delta?.text) {
      return { type: "text", text: obj.delta.text };
    }

    return null;
  } catch {
    if (line.length > 0) {
      return { type: "text", text: line };
    }
    return null;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
