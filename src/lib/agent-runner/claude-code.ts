import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";

const PROMPT_FILE = "/vercel/sandbox/.wallie-prompt.txt";

/**
 * Claude Code CLI agent runner.
 *
 * Runs `claude` inside a per-session sandbox, streams its JSON output as
 * AgentEvents. Expects `claude` to be on PATH inside the sandbox
 * (installed at sandbox boot by `createSessionSandbox`).
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly provider = "claude-code";

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const { sandbox } = input;

    // Vercel Sandbox's runCommand has no stdin support; materialise the prompt
    // as a file and pipe it via bash redirection.
    await sandbox.writeFile(PROMPT_FILE, input.prompt);

    const cliArgs = [
      "--print",
      "--output-format",
      "stream-json",
      "--max-turns",
      "1", // Single turn per invocation; multi-turn is handled by the orchestrator.
      "--verbose",
    ];
    if (input.continueSessionId) {
      cliArgs.push("--continue", input.continueSessionId);
    }
    cliArgs.push("--stdin");

    const shellCmd = `claude ${cliArgs.map(shellQuote).join(" ")} < ${shellQuote(PROMPT_FILE)}`;

    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: { CI: "1" },
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
      const event = parseStreamJsonLine(stdoutBuf.trim());
      if (event) yield event;
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
