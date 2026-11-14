import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  redactRunSensitiveText,
  redactRunToolText,
} from "@/lib/agent-runner/redact-sensitive-text";
import { AgentOutputSafety } from "@/lib/agent-runner/safety";
import type {
  AgentCaptureGap,
  AgentEvent,
  AgentRunner,
  AgentRunUsage,
} from "@/lib/agent-runner/types";
import type { Database } from "@/lib/supabase/database.types";

type CaptureGap =
  | "normalized_source_only"
  | AgentCaptureGap
  | "missing_terminal"
  | "stream_interrupted";

type NativeCaptureAdapter = "codex" | "claude-code";
type AdapterCoverage = {
  adapter: NativeCaptureAdapter;
  toolCalls: number;
  toolResults: number;
  unresolvedToolCalls: number;
  unmatchedToolResults: number;
  unsupportedEvents: number;
  truncatedEvents: number;
};

export type RunEventBody =
  | { kind: "text" | "progress"; payload: { text: string } }
  | { kind: "tool_call"; payload: { tool: string; input: string } }
  | {
      kind: "tool_result";
      payload: { tool: string; output: string; status: "success" | "error"; exitCode?: number };
    }
  | {
      kind: "terminal";
      payload: { status: "completed" | "incomplete"; summary: string; finalOutput?: string };
    }
  | { kind: "terminal"; payload: { status: "failed"; message: string } }
  | { kind: "usage"; payload: Pick<AgentRunUsage, keyof AgentRunUsage> }
  | { kind: "capture_gap"; payload: { reason: CaptureGap } }
  | {
      kind: "capture_end";
      payload: { status: "complete" | "interrupted"; coverage?: AdapterCoverage };
    };

type Projection = RunEventBody & { truncated?: boolean; legacyMessage?: string };
type AttemptIdentity = { jobId: string; runId: string; attemptCount: number };
const MAX_TEXT_BYTES = 7_500;
const MAX_LABEL_BYTES = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

export class ExecutionOwnershipLostError extends Error {
  constructor() {
    super("This execution no longer owns its run.");
    this.name = "ExecutionOwnershipLostError";
  }
}

export class RunEventCapture {
  private sequence = 0;
  private readonly safety = new AgentOutputSafety([]);
  private readonly toolCallSequences = new Map<string, number>();
  private readonly earlyToolResults = new Set<string>();
  private coverage: AdapterCoverage | undefined;

  constructor(
    private readonly admin: SupabaseClient<Database>,
    private readonly identity: AttemptIdentity,
  ) {}

  addSensitiveValue(value: string): void {
    this.safety.addSecret(value);
  }

  async start(adapter: AgentRunner["provider"]): Promise<void> {
    if (adapter === "codex" || adapter === "claude-code") {
      this.coverage = {
        adapter,
        toolCalls: 0,
        toolResults: 0,
        unresolvedToolCalls: 0,
        unmatchedToolResults: 0,
        unsupportedEvents: 0,
        truncatedEvents: 0,
      };
    } else {
      await this.markGap("normalized_source_only");
    }
  }

  async record(event: AgentEvent): Promise<void> {
    const redact = (text: string) => this.safety.redact(text);
    const projected = projectEvent(event, redact);
    const causationSequence =
      (event.type === "tool_result" || event.type === "capture_gap") && event.callId
        ? this.toolCallSequences.get(event.callId)
        : undefined;
    const sequence = await this.append(projected, { causationSequence });
    if (event.type === "tool_use" && event.callId && !this.earlyToolResults.delete(event.callId)) {
      this.toolCallSequences.set(event.callId, sequence);
    }
    if (
      this.coverage &&
      event.type === "tool_result" &&
      event.callId &&
      causationSequence === undefined
    ) {
      this.earlyToolResults.add(event.callId);
    }
    if (
      (event.type === "tool_result" ||
        (event.type === "capture_gap" && event.reason === "missing_tool_result")) &&
      event.callId
    ) {
      this.toolCallSequences.delete(event.callId);
    }

    const coverage = this.coverage;
    if (coverage) {
      if (projected.truncated) coverage.truncatedEvents++;
      if (event.type === "tool_use") coverage.toolCalls++;
      if (event.type === "tool_result") coverage.toolResults++;
      if (event.type === "capture_gap") {
        if (event.reason === "missing_tool_call") coverage.unmatchedToolResults++;
        if (event.reason === "missing_tool_result") coverage.unresolvedToolCalls++;
        if (event.reason === "unsupported_event") coverage.unsupportedEvents++;
      }
    }
    if (event.type === "completion" && event.usage) {
      const usage = projectUsage(event.usage, redact);
      await this.append(usage, { causationSequence: sequence });
      if (coverage && usage.truncated) coverage.truncatedEvents++;
    }
  }

  async markGap(reason: CaptureGap, signal?: AbortSignal): Promise<void> {
    await this.append({ kind: "capture_gap", payload: { reason } }, { signal });
  }

  async finish(status: "complete" | "interrupted", signal?: AbortSignal): Promise<void> {
    if (this.coverage) {
      for (const [callId, sequence] of this.toolCallSequences) {
        await this.append(
          { kind: "capture_gap", payload: { reason: "missing_tool_result" } },
          { causationSequence: sequence, signal },
        );
        this.coverage.unresolvedToolCalls++;
        this.toolCallSequences.delete(callId);
      }
    }
    await this.append(
      {
        kind: "capture_end",
        payload: { status, ...(this.coverage ? { coverage: this.coverage } : {}) },
      },
      { signal },
    );
  }

  private async append(
    event: Projection,
    { causationSequence, signal }: { causationSequence?: number; signal?: AbortSignal } = {},
  ): Promise<number> {
    const sequence = ++this.sequence;
    const { jobId, runId, attemptCount } = this.identity;
    const request = this.admin.rpc("append_agent_run_event", {
      p_job_id: jobId,
      p_run_id: runId,
      p_attempt_count: attemptCount,
      p_sequence: sequence,
      p_kind: event.kind,
      p_payload: event.payload,
      p_truncated: event.truncated ?? false,
      ...(causationSequence !== undefined ? { p_causation_sequence: causationSequence } : {}),
      ...(event.legacyMessage !== undefined ? { p_legacy_message_md: event.legacyMessage } : {}),
    });
    const { data, error } = await (signal ? request.abortSignal(signal) : request);
    if (error) throw error;
    if (!data) throw new ExecutionOwnershipLostError();
    return sequence;
  }
}

function projectEvent(event: AgentEvent, redactKnown: (text: string) => string): Projection {
  const capture = (text: string, limit = MAX_TEXT_BYTES) => captureText(redactKnown(text), limit);
  switch (event.type) {
    case "text":
    case "progress": {
      const text = capture(event.text);
      return {
        kind: event.type,
        payload: { text: text.excerpt },
        truncated: text.truncated,
        legacyMessage: text.full,
      };
    }
    case "tool_use": {
      const tool = capture(event.tool, MAX_LABEL_BYTES);
      const input = captureText(redactKnown(event.input), MAX_TEXT_BYTES, redactRunToolText);
      return {
        kind: "tool_call",
        payload: { tool: tool.excerpt, input: input.excerpt },
        truncated: event.captureTruncated || tool.truncated || input.truncated,
        legacyMessage: `**Tool:** ${tool.full}\n\n\`\`\`\n${input.full}\n\`\`\``,
      };
    }
    case "tool_result": {
      const tool = capture(event.tool, MAX_LABEL_BYTES);
      const output = captureText(redactKnown(event.output), MAX_TEXT_BYTES, redactRunToolText);
      return {
        kind: "tool_result",
        payload: {
          tool: tool.excerpt,
          output: output.excerpt,
          status: event.status,
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        },
        truncated: event.captureTruncated || tool.truncated || output.truncated,
      };
    }
    case "usage":
      return projectUsage(event.usage, redactKnown);
    case "completion": {
      const summary = capture(event.summary);
      const finalOutput = event.finalOutput?.trim() ? capture(event.finalOutput) : undefined;
      const genericSummary = summary.full.trim().toLowerCase() === "codex session completed";
      return {
        kind: "terminal",
        payload: {
          status: event.taskComplete ? "completed" : "incomplete",
          summary: summary.excerpt,
          ...(finalOutput ? { finalOutput: finalOutput.excerpt } : {}),
        },
        truncated: summary.truncated || finalOutput?.truncated,
        legacyMessage: finalOutput?.full ?? (genericSummary ? undefined : summary.full),
      };
    }
    case "error": {
      const message = capture(event.message);
      return {
        kind: "terminal",
        payload: { status: "failed", message: message.excerpt },
        truncated: event.captureTruncated || message.truncated,
        legacyMessage: `**Error:** ${message.full}`,
      };
    }
    case "capture_gap":
      return { kind: "capture_gap", payload: { reason: event.reason } };
    default: {
      // A runtime adapter can send a newer event shape. Record the gap without its payload.
      event satisfies never;
      return { kind: "capture_gap", payload: { reason: "unsupported_event" } };
    }
  }
}

function projectUsage(usage: AgentRunUsage, redact: (text: string) => string): Projection {
  const { inputTokens, outputTokens, provenance, costUsd, costProvenance, estimationRevision } =
    usage;
  const revision =
    estimationRevision === undefined
      ? undefined
      : captureText(redact(estimationRevision), MAX_LABEL_BYTES);
  return {
    kind: "usage",
    payload: {
      inputTokens,
      outputTokens,
      provenance: provenance ?? "measured",
      ...(costUsd !== undefined ? { costUsd, costProvenance: costProvenance ?? "measured" } : {}),
      ...(revision ? { estimationRevision: revision.excerpt } : {}),
    },
    truncated: revision?.truncated,
  };
}

function captureText(text: string, limit: number, redact = redactRunSensitiveText) {
  const full = decoder.decode(encoder.encode(redact(text))).replaceAll("\0", "\uFFFD");
  const fits = (value: string) => encoder.encode(JSON.stringify(value)).length <= limit;
  if (fits(full)) return { full, excerpt: full, truncated: false };

  // Count escaped JSON bytes, including Unicode and control characters.
  let low = 0;
  let high = Math.min(full.length, limit);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(full.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  if (full.charCodeAt(low - 1) >= 0xd800 && full.charCodeAt(low - 1) <= 0xdbff) low--;
  return { full, excerpt: full.slice(0, low), truncated: true };
}
