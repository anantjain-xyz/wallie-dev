import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { DEFAULT_CODEX_MODEL } from "./types";

const PROMPT_FILE = "/vercel/sandbox/.wallie-prompt.txt";
const CODEX_HOME = "/vercel/sandbox/.codex";

export interface CodexRunnerOptions {
  /** OAuth access token fetched via getCodexAccessTokenForUser. */
  accessToken: string;
  /** Model identifier (e.g. "gpt-5-codex"). */
  model?: string;
}

/**
 * Codex CLI agent runner.
 *
 * Runs `codex exec` inside a per-session sandbox. The OAuth access token is
 * materialised as `{CODEX_HOME}/auth.json` either by the sandbox factory
 * (first turn) or here on demand (subsequent turns or if the factory skipped
 * it). Streams stdout line-by-line as AgentEvents.
 *
 * Expects `codex` on PATH inside the sandbox (installed at sandbox boot).
 */
export class CodexRunner implements AgentRunner {
  readonly provider = "codex";

  constructor(private readonly options: CodexRunnerOptions) {
    if (!options.accessToken) {
      throw new Error("CodexRunner requires an accessToken.");
    }
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    const model = this.options.model ?? DEFAULT_CODEX_MODEL;

    // Ensure auth.json exists. Idempotent; overwrites are fine because the
    // token is fetched (and refreshed) per phase by the caller.
    await sandbox.writeFile(
      `${CODEX_HOME}/auth.json`,
      JSON.stringify({
        OPENAI_API_KEY: null,
        tokens: { access_token: this.options.accessToken },
      }),
      { mode: 0o600 },
    );

    await sandbox.writeFile(PROMPT_FILE, input.prompt);

    const cliArgs = ["exec", "--model", model, "--json", "-"];
    const shellCmd = `codex ${cliArgs.map(shellQuote).join(" ")} < ${shellQuote(PROMPT_FILE)}`;

    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: { CI: "1", CODEX_HOME },
    });

    let stdoutBuf = "";
    let stderrBuf = "";

    for await (const log of proc.logs()) {
      if (log.stream === "stderr") {
        stderrBuf += log.data;
        continue;
      }

      stdoutBuf += log.data;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseCodexLine(line);
        if (event) yield event;
      }
    }

    if (stdoutBuf.trim()) {
      const event = parseCodexLine(stdoutBuf);
      if (event) yield event;
    }

    const code = await proc.exitCode;
    if (code !== 0) {
      yield {
        type: "error",
        message: `codex CLI exited with code ${code}: ${stderrBuf.slice(0, 500)}`,
      };
    }

    yield {
      type: "completion",
      taskComplete: true,
      summary: "Codex session completed",
    };
  }
}

/**
 * Parse a single line of Codex CLI `--json` output. One JSON object per line.
 * Known event shapes:
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
