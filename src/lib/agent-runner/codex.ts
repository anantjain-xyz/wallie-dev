import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { DEFAULT_CODEX_MODEL } from "./types";

export interface CodexRunnerOptions {
  /** OAuth access token fetched via getCodexAccessTokenForUser. */
  accessToken: string;
  /** Model identifier (e.g. "gpt-5-codex"). */
  model?: string;
}

/**
 * Codex CLI agent runner.
 *
 * Launches `codex exec` as a subprocess in the workspace directory, feeding
 * the OAuth access token via a scratch CODEX_HOME dir so the CLI discovers
 * it exactly as it would from `~/.codex/auth.json` after `codex login`.
 * Streams stdout line-by-line as text events, emits a completion event
 * on exit.
 *
 * Requires `codex` to be available on the worker's PATH.
 */
export class CodexRunner implements AgentRunner {
  readonly provider = "codex";

  constructor(private readonly options: CodexRunnerOptions) {
    if (!options.accessToken) {
      throw new Error("CodexRunner requires an accessToken.");
    }
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const model = this.options.model ?? DEFAULT_CODEX_MODEL;

    // Materialise a Codex-compatible auth.json in a temp CODEX_HOME so the
    // CLI picks up the OAuth token without touching the user's real
    // ~/.codex/auth.json (or running in a fresh container where it doesn't
    // exist).
    const codexHome = await mkdtemp(path.join(tmpdir(), "wallie-codex-"));
    await writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: this.options.accessToken } }),
      { mode: 0o600 },
    );

    const args = ["exec", "--model", model, "--json", "-"];

    const child = spawn("codex", args, {
      cwd: input.workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CI: "1",
        CODEX_HOME: codexHome,
      },
    });

    child.stdin.write(input.prompt);
    child.stdin.end();

    let buffer = "";
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
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = parseCodexLine(line);
        if (event) enqueue(event);
      }
    });

    let stderrOutput = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString("utf-8");
    });

    const cleanup = async () => {
      await rm(codexHome, { force: true, recursive: true }).catch(() => {
        // Non-fatal: temp dir cleanup is best-effort.
      });
    };

    child.on("close", async (code) => {
      if (buffer.trim()) {
        const event = parseCodexLine(buffer);
        if (event) enqueue(event);
      }

      if (code !== 0 && code !== null) {
        enqueue({
          type: "error",
          message: `codex CLI exited with code ${code}: ${stderrOutput.slice(0, 500)}`,
        });
      }

      await cleanup();
      enqueue(null);
    });

    child.on("error", async (err) => {
      enqueue({
        type: "error",
        message: `Failed to spawn codex CLI: ${err.message}`,
      });
      await cleanup();
      enqueue(null);
    });

    while (true) {
      await waitForEvent();
      while (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        if (event === null) {
          yield {
            type: "completion",
            taskComplete: true,
            summary: "Codex session completed",
          } satisfies AgentEvent;
          return;
        }
        yield event;
      }
    }
  }
}

/**
 * Parse a single line of Codex CLI `--json` output. The CLI emits one JSON
 * object per line. Known event shapes:
 *   { type: "message", role: "assistant", content: "..." }
 *   { type: "text", text: "..." }
 *   { type: "tool_call", name: "...", arguments: {...} }
 *   { type: "result", summary: "..." }
 * Unknown shapes fall through to a raw-text event so we don't silently drop
 * output.
 */
export function parseCodexLine(raw: string): AgentEvent | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;

    if (obj.type === "text" && typeof obj.text === "string") {
      return { type: "text", text: obj.text };
    }

    if (obj.type === "message" && typeof obj.content === "string") {
      return { type: "text", text: obj.content };
    }

    if (obj.type === "tool_call" && typeof obj.name === "string") {
      const input =
        typeof obj.arguments === "string" ? obj.arguments : JSON.stringify(obj.arguments ?? {});
      return { type: "tool_use", tool: obj.name, input };
    }

    if (obj.type === "result") {
      const summary =
        typeof obj.summary === "string"
          ? obj.summary
          : typeof obj.result === "string"
            ? obj.result
            : "Codex run finished";
      return { type: "completion", taskComplete: true, summary };
    }

    return null;
  } catch {
    return { type: "text", text: trimmed };
  }
}
