import { z } from "zod";

import type { Enums } from "@/lib/supabase/database.types";

export const RUN_TRANSCRIPT_PAGE_SIZE = 30;
export const RUN_TRANSCRIPT_MAX_PAGE_SIZE = 50;
export const RUN_TRANSCRIPT_ENTRY_BYTES = 8_192;

export const runTranscriptParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  runId: z.string().uuid(),
});

export const runTranscriptQuerySchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    direction: z.enum(["older", "newer"]).optional(),
    limit: z
      .string()
      .regex(/^[1-9][0-9]?$/)
      .transform(Number)
      .pipe(z.number().int().max(RUN_TRANSCRIPT_MAX_PAGE_SIZE))
      .optional(),
  })
  .strict()
  .refine((value) => value.direction !== "newer" || Boolean(value.cursor), {
    message: "Forward transcript pages require a cursor.",
  });

const count = z.number().int().nonnegative().safe();
const coverageSchema = z.object({
  adapter: z.enum(["codex", "claude-code", "cursor", "opencode"]),
  limitations: z
    .array(
      z.enum([
        "usage_unavailable",
        "tool_identity_may_be_unavailable",
        "tool_start_may_be_unavailable",
        "child_session_events_unavailable",
        "terminal_inferred_from_final_step",
      ]),
    )
    .max(5)
    .optional(),
  toolCalls: count,
  toolResults: count,
  unresolvedToolCalls: count,
  unmatchedToolResults: count,
  unsupportedEvents: count,
  truncatedEvents: count,
});

export const runTranscriptBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), payload: z.object({ text: z.string() }) }),
  z.object({ kind: z.literal("progress"), payload: z.object({ text: z.string() }) }),
  z.object({
    kind: z.literal("tool_call"),
    payload: z.object({ tool: z.string(), input: z.string() }),
  }),
  z.object({
    kind: z.literal("tool_result"),
    payload: z.object({
      tool: z.string(),
      output: z.string(),
      status: z.enum(["success", "error"]),
      outcome: z.literal("rejected").optional(),
      exitCode: z.number().int().safe().optional(),
    }),
  }),
  z.object({
    kind: z.literal("terminal"),
    payload: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("completed"),
        summary: z.string(),
        finalOutput: z.string().optional(),
      }),
      z.object({
        status: z.literal("incomplete"),
        summary: z.string(),
        finalOutput: z.string().optional(),
      }),
      z.object({ status: z.literal("failed"), message: z.string() }),
    ]),
  }),
  z.object({
    kind: z.literal("usage"),
    payload: z.object({
      inputTokens: count,
      outputTokens: count,
      provenance: z.enum(["measured", "estimated"]),
      costUsd: z.number().nonnegative().finite().optional(),
      costProvenance: z.enum(["measured", "estimated"]).optional(),
      estimationRevision: z.string().optional(),
    }),
  }),
  z.object({
    kind: z.literal("capture_gap"),
    payload: z.object({
      reason: z.enum([
        "normalized_source_only",
        "unsupported_event",
        "missing_tool_call",
        "missing_tool_result",
        "missing_terminal",
        "stream_interrupted",
      ]),
    }),
  }),
  z.object({
    kind: z.literal("capture_end"),
    payload: z.object({
      status: z.enum(["complete", "interrupted"]),
      coverage: coverageSchema.optional(),
    }),
  }),
  z.object({
    kind: z.literal("legacy"),
    payload: z.object({
      kind: z.enum([
        "user",
        "assistant",
        "text",
        "progress",
        "tool_use",
        "completion",
        "error",
        "run_failure",
        "unknown",
      ]),
      text: z.string(),
    }),
  }),
]);

export type RunTranscriptBody = z.infer<typeof runTranscriptBodySchema>;
export type RunTranscriptEntry = RunTranscriptBody & {
  id: string;
  createdAt: string;
  sequence: number | null;
  causationSequence: number | null;
  truncated: boolean;
};
export type RunTranscriptQuery = z.output<typeof runTranscriptQuerySchema>;
export type RunTranscriptPage = {
  runId: string;
  runStatus: Enums<"agent_run_status">;
  attemptCount: number | null;
  mode: "events" | "legacy";
  entries: RunTranscriptEntry[];
  olderCursor: string | null;
  newerCursor: string;
  hasOlder: boolean;
  hasNewer: boolean;
};
