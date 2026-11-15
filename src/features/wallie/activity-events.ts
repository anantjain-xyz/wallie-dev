import { z } from "zod";

import { mapAgentRunMessageRow } from "@/features/wallie/data";
import { runTranscriptBodySchema } from "@/features/wallie/run-transcript-contracts";
import type { WallieRunMessage } from "@/features/wallie/types";

export const ACTIVITY_EVENT_KINDS = ["text", "progress", "tool_call", "tool_result", "terminal"];

const activityEventRow = z.object({
  agent_run_id: z.string(),
  attempt_count: z.number().int().positive(),
  sequence: z.number().int().positive(),
  schema_version: z.literal(1),
  created_at: z.string(),
  kind: z.string(),
  payload: z.unknown(),
});

export function mapActivityEvent(
  row: unknown,
  runId: string,
  attemptCount: number | null,
): WallieRunMessage | null {
  const envelope = activityEventRow.safeParse(row);
  if (
    !envelope.success ||
    envelope.data.agent_run_id !== runId ||
    envelope.data.attempt_count !== attemptCount
  )
    return null;
  const event = runTranscriptBodySchema.safeParse(envelope.data);
  if (!event.success) return null;
  const source = event.data;
  const { agent_run_id, attempt_count, created_at, sequence } = envelope.data;
  const message = {
    id: `event:${agent_run_id}:${attempt_count}:${sequence}`,
    createdAt: created_at,
    sequence,
  };
  switch (source.kind) {
    case "text":
    case "progress":
      return { ...message, kind: source.kind, messageMd: source.payload.text };
    case "tool_call":
      return {
        ...message,
        kind: source.kind,
        tool: source.payload.tool,
        messageMd: source.payload.input,
      };
    case "tool_result":
      return {
        ...message,
        kind: source.kind,
        tool: source.payload.tool,
        messageMd: source.payload.output,
        outcome: source.payload.outcome ?? source.payload.status,
      };
    case "terminal": {
      if (source.payload.status === "failed")
        return { ...message, kind: "error", messageMd: source.payload.message };
      const { finalOutput, summary } = source.payload;
      const text = finalOutput ?? summary;
      if (text.trim().toLowerCase() === "codex session completed") return null;
      return { ...message, kind: "completion", messageMd: text };
    }
    default:
      return null;
  }
}

const workerMessageRow = z.object({
  agent_run_id: z.string(),
  created_at: z.string(),
  id: z.string(),
  kind: z.string(),
  message_md: z.string(),
});

export function mapRealtimeWorkerMessage(row: unknown, runId: string): WallieRunMessage | null {
  const parsed = workerMessageRow.safeParse(row);
  return parsed.success && parsed.data.agent_run_id === runId
    ? mapAgentRunMessageRow(parsed.data)
    : null;
}
