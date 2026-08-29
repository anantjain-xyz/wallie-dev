import type { AgentEffort } from "@/lib/agent-config/contracts";
import type { CursorCredential } from "@/lib/cursor/contracts";
import { WALLIE_GIT_IDENTITY_ENV } from "@/lib/sandbox/commit-author";

import type { AgentEvent, AgentRunner, AgentRunnerStartInput } from "./types";
import { DEFAULT_CURSOR_MODEL } from "./types";

const PROMPT_FILE_NAME = ".wallie-cursor-prompt.txt";

export interface CursorRunnerOptions {
  credential: CursorCredential;
  effort?: AgentEffort;
  model?: string;
  onAuthenticationFailure?: (reason: string) => Promise<void>;
}

export class CursorRunner implements AgentRunner {
  readonly provider = "cursor";
  readonly requiresSandbox = true;

  constructor(private readonly options: CursorRunnerOptions) {
    if (!options.credential?.secret) throw new Error("CursorRunner requires a Cursor API key.");
  }

  async *start(input: AgentRunnerStartInput): AsyncIterable<AgentEvent> {
    if (!input.sandbox) throw new Error("CursorRunner requires a sandbox.");
    const sandbox = input.sandbox;
    const promptFile = `${sandbox.repoPath}/${PROMPT_FILE_NAME}`;
    await sandbox.writeFile(promptFile, input.prompt, { mode: 0o600 });

    const args = [
      "-p",
      "--force",
      "--trust",
      "--workspace",
      sandbox.repoPath,
      "--output-format",
      "stream-json",
      "--model",
      this.options.model ?? DEFAULT_CURSOR_MODEL,
    ];
    if (input.continueSessionId) args.push("--resume", input.continueSessionId);
    const command = [
      'cursor_bin="$(command -v cursor-agent || true)"',
      '[ -n "$cursor_bin" ] || cursor_bin="$HOME/.local/bin/cursor-agent"',
      `"$cursor_bin" ${args.map(shellQuote).join(" ")} < ${shellQuote(promptFile)}`,
    ].join("\n");

    const proc = await sandbox.exec("bash", ["-lc", command], {
      cwd: sandbox.repoPath,
      env: { CI: "1", CURSOR_API_KEY: this.options.credential.secret, ...WALLIE_GIT_IDENTITY_ENV },
      signal: input.signal,
    });

    let stdout = "";
    let stderr = "";
    let sessionId: string | undefined;
    let sawCompletion = false;
    for await (const log of proc.logs()) {
      if (log.stream === "stderr") {
        stderr += log.data;
        continue;
      }
      stdout += log.data;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseCursorStreamJsonLine(line);
        if (parsed.sessionId) sessionId = parsed.sessionId;
        if (parsed.event?.type === "completion") sawCompletion = true;
        if (parsed.event) yield parsed.event;
      }
    }
    if (stdout.trim()) {
      const parsed = parseCursorStreamJsonLine(stdout);
      if (parsed.sessionId) sessionId = parsed.sessionId;
      if (parsed.event?.type === "completion") sawCompletion = true;
      if (parsed.event) yield parsed.event;
    }

    const code = await proc.exitCode;
    if (code !== 0) {
      const reason = `Cursor CLI exited with code ${code}: ${stderr.trim().slice(0, 500)}`;
      if (isCursorAuthenticationError(stderr)) await this.options.onAuthenticationFailure?.(reason);
      yield { message: reason, type: "error" };
      return;
    }
    if (!sawCompletion) {
      yield {
        summary: sessionId ? `Cursor session: ${sessionId}` : "Cursor session completed",
        taskComplete: true,
        type: "completion",
      };
    }
  }
}

export function parseCursorStreamJsonLine(line: string): {
  event: AgentEvent | null;
  sessionId?: string;
} {
  const trimmed = line.trim();
  if (!trimmed) return { event: null };
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
    if (value.type === "assistant") {
      const text = extractText(value.message ?? value.text);
      return { event: text ? { text, type: "text" } : null, sessionId };
    }
    if (value.type === "tool_call") {
      const toolCall = (value.tool_call ?? value) as Record<string, unknown>;
      const tool = String(toolCall.name ?? toolCall.type ?? value.subtype ?? "tool");
      return {
        event: {
          input: JSON.stringify(toolCall.input ?? toolCall.args ?? {}),
          tool,
          type: "tool_use",
        },
        sessionId,
      };
    }
    if (value.type === "result") {
      return {
        event: {
          summary: extractText(value.result ?? value.summary) || "Cursor session completed",
          taskComplete: true,
          type: "completion",
        },
        sessionId,
      };
    }
    return { event: null, sessionId };
  } catch {
    return { event: { text: trimmed, type: "text" } };
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const object = value as Record<string, unknown>;
  if (typeof object.text === "string") return object.text;
  if (Array.isArray(object.content)) {
    return object.content
      .map((item) => extractText(item))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isCursorAuthenticationError(stderr: string): boolean {
  return /(?:401|unauthori[sz]ed|invalid api key|authentication failed|expired api key)/i.test(
    stderr,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
