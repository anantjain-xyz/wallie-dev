import { randomUUID } from "node:crypto";

import type { SandboxHandle } from "@/lib/sandbox/types";

import type { AgentEvent, AgentRunnerStartInput } from "./types";

/** Harness state must never be part of the repository the agent can commit. */
export async function prepareRunnerDirectory(
  provider: string,
  sandbox: SandboxHandle,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const directory = `/tmp/wallie-${provider}-${randomUUID()}`;
  const process = await sandbox.exec("mkdir", ["-m", "700", directory], {
    cwd: "/tmp",
    signal,
  });
  if ((await process.exitCode) !== 0) {
    throw new Error("Could not create a private agent directory.");
  }
  signal?.throwIfAborted();
  return directory;
}

/** Each invocation owns its current secrets; runners register only authorized credentials. */
export class AgentOutputSafety {
  private readonly secrets: string[] = [];

  constructor(secrets: AgentRunnerStartInput["secrets"]) {
    for (const secret of secrets ?? []) this.addSecret(secret);
  }

  addSecret(secret: string | undefined): void {
    if (!secret) return;
    this.secrets.push(secret);
    // Codex subscription auth is a JSON envelope. Redact individual tokens as
    // well as the envelope, including when the CLI prints a reformatted cache.
    try {
      this.addSecretFields(JSON.parse(secret));
    } catch {
      // API keys and access tokens are normally scalar strings.
    }
  }

  redact(value: string): string {
    return this.secretVariants().reduce(
      (text, secret) => text.replaceAll(secret, "[REDACTED]"),
      value,
    );
  }

  async *events(
    source: AsyncIterable<AgentEvent>,
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    let pending: AgentEvent[] = [];
    try {
      for await (const event of source) {
        signal?.throwIfAborted();
        pending.push(this.sanitizeNonTextEvent(event));
        // NDJSON parsers assemble transport chunks. This boundary also protects
        // credentials split between semantic text deltas, including when tool
        // or progress events arrive between them. Preserve original event order
        // and boundaries so artifact assembly does not introduce new line breaks.
        pending = this.redactTextEvents(pending, "text");
        pending = this.redactTextEvents(pending, "progress");
        const retainFrom = Math.min(
          this.pendingPrefixEventIndex(pending, "text"),
          this.pendingPrefixEventIndex(pending, "progress"),
        );
        for (const safe of pending.splice(0, retainFrom)) yield safe;
      }
      signal?.throwIfAborted();
      yield* pending;
    } catch (error) {
      // SDK/setup failures can embed command environment or credential JSON.
      // Never retain an unsanitized cause/stack on the error crossing this edge.
      const sanitized = new Error(
        this.redact(error instanceof Error ? error.message : String(error)),
      );
      sanitized.name = error instanceof Error ? error.name : "AgentRunnerError";
      throw sanitized;
    }
  }

  private sanitizeNonTextEvent(event: AgentEvent): AgentEvent {
    switch (event.type) {
      case "tool_use":
        return { ...event, tool: this.redact(event.tool), input: this.redact(event.input) };
      case "completion":
        return {
          ...event,
          summary: this.redact(event.summary),
          ...(event.finalOutput !== undefined
            ? { finalOutput: this.redact(event.finalOutput) }
            : {}),
        };
      case "error":
        return { ...event, message: this.redact(event.message) };
      default:
        return event;
    }
  }

  private redactTextEvents(events: AgentEvent[], type: "text" | "progress"): AgentEvent[] {
    const text = events.flatMap((event) => (event.type === type ? [event.text] : [])).join("");
    const ranges: Array<{ start: number; end: number }> = [];
    for (const secret of this.secretVariants()) {
      for (
        let start = text.indexOf(secret);
        start !== -1;
        start = text.indexOf(secret, start + secret.length)
      ) {
        ranges.push({ start, end: start + secret.length });
      }
    }
    if (!ranges.length) return events;
    ranges.sort((left, right) => left.start - right.start || right.end - left.end);
    const merged: typeof ranges = [];
    for (const range of ranges) {
      const previous = merged.at(-1);
      if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }
    let offset = 0;
    return events.map((event) => {
      if (event.type !== type) return event;
      const start = offset;
      const end = start + event.text.length;
      offset = end;
      let cursor = start;
      let safeText = "";
      for (const match of merged) {
        if (match.end <= start || match.start >= end) continue;
        safeText += text.slice(cursor, Math.max(cursor, match.start));
        if (match.start >= start) safeText += "[REDACTED]";
        cursor = Math.min(end, match.end);
      }
      safeText += text.slice(cursor, end);
      return { ...event, text: safeText };
    });
  }

  private pendingPrefixEventIndex(events: AgentEvent[], type: "text" | "progress"): number {
    const text = events.flatMap((event) => (event.type === type ? [event.text] : [])).join("");
    let suffixLength = 0;
    for (const candidate of this.secretVariants()) {
      for (
        let length = Math.min(text.length, candidate.length - 1);
        length > suffixLength;
        length--
      ) {
        if (text.endsWith(candidate.slice(0, length))) {
          suffixLength = length;
          break;
        }
      }
    }
    if (!suffixLength) return events.length;
    const prefixStart = text.length - suffixLength;
    let offset = 0;
    for (const [index, event] of events.entries()) {
      if (event.type !== type) continue;
      offset += event.text.length;
      if (offset > prefixStart) return index;
    }
    return events.length;
  }

  private secretVariants(): string[] {
    return [
      ...new Set(
        this.secrets.flatMap((secret) => [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ]),
      ),
    ].sort((left, right) => right.length - left.length);
  }

  private addSecretFields(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /token|secret|api[_-]?key|password|credential/i.test(key)) {
        this.secrets.push(child);
      } else if (typeof child === "object") {
        this.addSecretFields(child);
      }
    }
  }
}
