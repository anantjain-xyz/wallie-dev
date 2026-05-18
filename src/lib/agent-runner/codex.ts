import type { CodexCredential } from "@/lib/codex/contracts";
import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_REASONING_EFFORT } from "./types";

const PROMPT_FILE = "/vercel/sandbox/.wallie-prompt.txt";
const CODEX_HOME = "/vercel/sandbox/.codex";

export interface CodexRunnerOptions {
  /** User-supplied Codex credential resolved by getCodexCredentialForUser. */
  credential: CodexCredential;
  /** Model identifier (e.g. "gpt-5.5"). */
  model?: string;
}

/**
 * Codex CLI agent runner.
 *
 * Runs `codex exec` inside a per-session sandbox. Platform API keys are
 * injected only into the process environment; Codex access tokens are first
 * logged into the fresh sandbox via the CLI so it can materialize auth.json.
 * Streams stdout line-by-line as AgentEvents.
 *
 * Expects `codex` on PATH inside the sandbox (installed at sandbox boot).
 */
export class CodexRunner implements AgentRunner {
  readonly provider = "codex";
  readonly requiresSandbox = true;

  constructor(private readonly options: CodexRunnerOptions) {
    if (!options.credential?.secret) {
      throw new Error("CodexRunner requires a Codex credential.");
    }
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    const { sandbox } = input;
    if (!sandbox) {
      throw new Error("CodexRunner requires a sandbox.");
    }
    const model = this.options.model ?? DEFAULT_CODEX_MODEL;

    await sandbox.writeFile(PROMPT_FILE, input.prompt);

    const cliArgs = [
      "exec",
      "--model",
      model,
      "-c",
      `model_reasoning_effort="${DEFAULT_CODEX_REASONING_EFFORT}"`,
      "--json",
      "-",
    ];
    const execCmd = `codex ${cliArgs.map(shellQuote).join(" ")} < ${shellQuote(PROMPT_FILE)}`;
    const loginCmd = codexCredentialLoginCommand(this.options.credential);
    const shellCmd = [loginCmd, execCmd].filter(Boolean).join(" && ");

    const proc = await sandbox.exec("bash", ["-lc", shellCmd], {
      cwd: sandbox.repoPath,
      env: { CI: "1", CODEX_HOME, ...codexCredentialEnv(this.options.credential) },
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

function codexCredentialEnv(credential: CodexCredential): Record<string, string> {
  switch (credential.type) {
    case "codex_access_token":
      return { CODEX_ACCESS_TOKEN: credential.secret };
    case "platform_api_key":
      return { OPENAI_API_KEY: credential.secret };
  }
}

function codexCredentialLoginCommand(credential: CodexCredential): string | null {
  switch (credential.type) {
    case "codex_access_token":
      return `printf '%s' "$CODEX_ACCESS_TOKEN" | codex login --with-access-token >/dev/stderr`;
    case "platform_api_key":
      return null;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
