import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { AgentOutputSafety } from "@/lib/agent-runner/safety";
import type { AgentEvent, AgentRunner } from "@/lib/agent-runner/types";
import { RunEventCapture } from "@/lib/pipeline/run-events";
import { observeUntilAbort } from "@/lib/sandbox/lifecycle";
import type { Database } from "@/lib/supabase/database.types";

const maxEvents = 32;
const maxTextCharacters = 8_192;
const persistTimeoutMs = 2_000;
const settlementHeadroomMs = 4_000;

export class BenchmarkTrialTranscript {
  private readonly events: AgentEvent[] = [];
  private observedTerminal = false;
  private limited = false;

  record(event: AgentEvent): void {
    if (event.type === "error" || event.type === "completion") this.observedTerminal = true;
    if (this.events.length >= maxEvents) {
      this.limited = true;
      return;
    }

    switch (event.type) {
      case "tool_use":
        this.events.push({
          ...event,
          tool: this.retain(event.tool),
          input: "[Tool input withheld.]",
          callId: event.callId && event.callId.length <= 256 ? event.callId : undefined,
        });
        return;
      case "tool_result":
        this.events.push({
          ...event,
          tool: this.retain(event.tool),
          output: "[Tool output withheld.]",
          callId: event.callId && event.callId.length <= 256 ? event.callId : undefined,
        });
        return;
      case "text":
      case "progress":
        this.events.push({ ...event, text: this.retain(event.text) });
        return;
      case "completion":
        this.events.push({
          ...event,
          summary: this.retain(event.summary),
          finalOutput: event.finalOutput === undefined ? undefined : this.retain(event.finalOutput),
        });
        return;
      case "error":
        this.events.push({ ...event, message: this.retain(event.message) });
        return;
      case "usage":
      case "capture_gap":
        this.events.push(event);
        return;
      case "mcp_receipt":
        this.limited = true;
        return;
    }
  }

  async persist(input: {
    admin: SupabaseClient<Database>;
    identity: { jobId: string; runId: string; attemptCount: number };
    adapter: AgentRunner["provider"];
    sensitiveValues: readonly string[] | null;
    signal: AbortSignal;
    deadlineMs: number;
  }) {
    const { admin, identity, adapter, sensitiveValues, signal, deadlineMs } = input;
    if (
      !sensitiveValues ||
      !this.events.length ||
      Date.now() + persistTimeoutMs + settlementHeadroomMs >= deadlineMs
    )
      return;

    const localSignal = AbortSignal.any([signal, AbortSignal.timeout(persistTimeoutMs)]);
    const safety = new AgentOutputSafety([...sensitiveValues]);
    const capture = new RunEventCapture(admin, identity);
    const events = this.events;
    async function* source() {
      yield* events;
    }
    await observeUntilAbort(localSignal, async () => {
      capture.start(adapter);
      for await (const event of safety.events(source(), localSignal)) {
        await capture.record(event, localSignal);
      }
      if (!this.observedTerminal) await capture.markGap("missing_terminal", localSignal);
      await capture.finish(
        this.observedTerminal && !this.limited ? "complete" : "interrupted",
        localSignal,
      );
    }).catch(() => undefined);
  }

  private retain(text: string): string {
    if (text.length <= maxTextCharacters) return text;
    this.limited = true;
    return "[Content omitted because it exceeds the transcript limit.]";
  }
}
