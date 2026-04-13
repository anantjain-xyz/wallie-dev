import { spawn } from "node:child_process";

import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";

/**
 * Claude Code CLI agent runner.
 *
 * Launches the `claude` CLI as a subprocess in the workspace directory,
 * streams its JSON output lines as AgentEvents.
 *
 * Requires `claude` to be available on the worker's PATH.
 * Uses `--output-format stream-json` for structured output.
 */
export class ClaudeCodeRunner implements AgentRunner {
  readonly provider = "claude-code";

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--max-turns",
      "1", // Single turn per invocation; multi-turn is handled by the orchestrator.
      "--verbose",
    ];

    // If continuing a previous session, pass the session flag.
    if (input.continueSessionId) {
      args.push("--continue", input.continueSessionId);
    }

    // The prompt is passed via stdin to avoid shell escaping issues.
    args.push("--stdin");

    const child = spawn("claude", args, {
      cwd: input.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Disable interactive features in the CLI.
        CI: "1",
      },
    });

    // Write prompt to stdin and close.
    child.stdin.write(input.prompt);
    child.stdin.end();

    // Buffer partial lines from stdout.
    let buffer = "";
    let lastSessionId: string | undefined;

    const eventQueue: (AgentEvent | null)[] = [];
    let resolve: (() => void) | null = null;

    function enqueue(event: AgentEvent | null) {
      eventQueue.push(event);
      if (resolve) {
        resolve();
        resolve = null;
      }
    }

    function waitForEvent(): Promise<void> {
      if (eventQueue.length > 0) return Promise.resolve();
      return new Promise<void>((r) => {
        resolve = r;
      });
    }

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const lines = buffer.split("\n");
      // Keep the last partial line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const event = parseStreamJsonLine(trimmed);
        if (event) {
          enqueue(event);
        }

        // Extract session ID from the stream for continuation.
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.session_id) {
            lastSessionId = parsed.session_id;
          }
        } catch {
          // Not JSON — ignore.
        }
      }
    });

    let stderrOutput = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      // Flush remaining buffer.
      if (buffer.trim()) {
        const event = parseStreamJsonLine(buffer.trim());
        if (event) {
          enqueue(event);
        }
      }

      if (code !== 0 && code !== null) {
        enqueue({
          type: "error",
          message: `claude CLI exited with code ${code}: ${stderrOutput.slice(0, 500)}`,
        });
      }

      // Signal end of stream.
      enqueue(null);
    });

    child.on("error", (err) => {
      enqueue({
        type: "error",
        message: `Failed to spawn claude CLI: ${err.message}`,
      });
      enqueue(null);
    });

    // Yield events as they arrive.
    while (true) {
      await waitForEvent();
      while (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        if (event === null) {
          // End of stream — emit completion event with session info.
          yield {
            type: "completion",
            taskComplete: true,
            summary: lastSessionId
              ? `Claude Code session: ${lastSessionId}`
              : "Claude Code session completed",
          } satisfies AgentEvent;
          return;
        }
        yield event;
      }
    }
  }
}

/**
 * Parse a single JSON line from Claude Code's stream-json output format.
 * Returns an AgentEvent or null if the line is not actionable.
 */
function parseStreamJsonLine(line: string): AgentEvent | null {
  try {
    const obj = JSON.parse(line);

    // Claude Code stream-json emits various message types.
    // The key ones we care about:
    // - type: "assistant" with content blocks
    // - type: "result" with final summary
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

    // Content block delta events (streaming text)
    if (obj.type === "content_block_delta" && obj.delta?.text) {
      return { type: "text", text: obj.delta.text };
    }

    return null;
  } catch {
    // Not valid JSON — treat as raw text output.
    if (line.length > 0) {
      return { type: "text", text: line };
    }
    return null;
  }
}
