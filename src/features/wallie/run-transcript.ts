import "server-only";

import { z } from "zod";

import {
  RUN_TRANSCRIPT_ENTRY_BYTES,
  RUN_TRANSCRIPT_MAX_PAGE_SIZE,
  RUN_TRANSCRIPT_PAGE_SIZE,
  runTranscriptBodySchema,
  type RunTranscriptBody,
  type RunTranscriptEntry,
  type RunTranscriptPage,
  type RunTranscriptQuery,
} from "@/features/wallie/run-transcript-contracts";
import {
  redactRunSensitiveText,
  redactRunToolText,
} from "@/lib/agent-runner/redact-sensitive-text";
import { parseRunFailure } from "@/lib/pipeline/run-failure";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type Input = { supabase: Client; workspaceId: string; runId: string; query?: RunTranscriptQuery };
const scopeSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().uuid(),
  runId: z.string().uuid(),
  attemptCount: z.number().int().positive().nullable(),
});
const cursorSchema = z.discriminatedUnion("mode", [
  scopeSchema.extend({
    mode: z.literal("events"),
    sequence: z.number().int().nonnegative().max(2_147_483_647),
  }),
  scopeSchema.extend({
    mode: z.literal("legacy"),
    createdAt: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  }),
]);
type Cursor = z.infer<typeof cursorSchema>;
const origin = {
  createdAt: "0001-01-01T00:00:00.000000+00:00",
  id: "00000000-0000-0000-0000-000000000000",
};

export class RunTranscriptCursorError extends Error {
  constructor() {
    super("Invalid run transcript cursor.");
    this.name = "RunTranscriptCursorError";
  }
}
export class RunTranscriptResetError extends Error {
  constructor() {
    super("Transcript source changed. Refresh the transcript.");
    this.name = "RunTranscriptResetError";
  }
}

export async function loadRunTranscript(input: Input): Promise<RunTranscriptPage | null> {
  const owner = await readOwner(input);
  if (!owner) return null;
  const mode = owner.has_events && owner.attempt_count !== null ? "events" : "legacy";
  const scope = {
    version: 1,
    workspaceId: input.workspaceId,
    runId: owner.run_id,
    attemptCount: owner.attempt_count ?? null,
  } satisfies z.infer<typeof scopeSchema>;
  const cursor = input.query?.cursor ? readCursor(input.query.cursor, scope, mode) : null;
  if (owner.transcript_expired_at)
    return expiredPage(scope, owner.status, owner.transcript_expired_at);
  const direction = input.query?.direction ?? "older";
  if (direction === "newer" && !cursor) throw new RunTranscriptCursorError();
  const limit = Math.min(
    RUN_TRANSCRIPT_MAX_PAGE_SIZE,
    Math.max(1, input.query?.limit ?? RUN_TRANSCRIPT_PAGE_SIZE),
  );
  const forward = direction === "newer";
  let entries: RunTranscriptEntry[];
  let boundaries: Cursor[];
  let hasMore: boolean;

  if (mode === "events" && owner.attempt_count !== null) {
    let query = input.supabase
      .from("agent_run_events")
      .select("sequence, causation_sequence, created_at, kind, payload, schema_version, truncated")
      .eq("workspace_id", input.workspaceId)
      .eq("agent_run_id", owner.run_id)
      .eq("attempt_count", owner.attempt_count)
      .order("sequence", { ascending: forward })
      .limit(limit + 1);
    if (cursor?.mode === "events") {
      query = forward
        ? query.gt("sequence", cursor.sequence)
        : query.lt("sequence", cursor.sequence);
    }
    const { data, error } = await query;
    if (error) throw error;
    const rows = data ?? [];
    hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    if (!forward) pageRows.reverse();
    boundaries = pageRows.map((row) => ({ ...scope, mode: "events", sequence: row.sequence }));
    entries = pageRows.map((row) => {
      const parsed =
        row.schema_version === 1
          ? runTranscriptBodySchema.safeParse({ kind: row.kind, payload: row.payload })
          : null;
      const body: RunTranscriptBody =
        parsed?.success && parsed.data.kind !== "legacy"
          ? parsed.data
          : { kind: "capture_gap", payload: { reason: "unsupported_event" } };
      return boundEntry({
        ...body,
        id: `event:${owner.run_id}:${owner.attempt_count}:${row.sequence}`,
        createdAt: row.created_at,
        sequence: row.sequence,
        causationSequence: row.causation_sequence,
        truncated: row.truncated,
      });
    });
  } else {
    const { data, error } = await input.supabase.rpc("list_run_legacy_transcript", {
      p_workspace_id: input.workspaceId,
      p_run_id: owner.run_id,
      p_limit: limit + 1,
      p_direction: direction,
      ...(cursor?.mode === "legacy"
        ? { p_cursor_created_at: cursor.createdAt, p_cursor_id: cursor.id }
        : {}),
    });
    if (error?.code === "P0002") return null;
    if (error) throw error;
    const rows = data ?? [];
    hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    if (!forward) pageRows.reverse();
    boundaries = pageRows.map((row) => ({
      ...scope,
      mode: "legacy",
      createdAt: row.created_at,
      id: row.id,
    }));
    entries = pageRows.map((row) =>
      boundEntry({
        ...legacyBody(row.kind, row.message_excerpt),
        id: `message:${row.id}`,
        createdAt: row.created_at,
        sequence: null,
        causationSequence: null,
        truncated: row.message_truncated,
      }),
    );
  }

  // A second RLS lookup prevents a revoked membership from masquerading as an
  // empty transcript, and carries current terminal status across reconnects.
  const current = await readOwner(input);
  if (!current) return null;
  if (current.transcript_expired_at)
    return expiredPage(scope, current.status, current.transcript_expired_at);
  const currentMode = current.has_events && current.attempt_count !== null ? "events" : "legacy";
  if (currentMode !== mode || current.attempt_count !== owner.attempt_count)
    throw new RunTranscriptResetError();
  if (!cursor && !isTerminal(owner.status) && isTerminal(current.status))
    throw new RunTranscriptResetError();
  const first = boundaries.at(0);
  const last = boundaries.at(-1);
  const initialBoundary: Cursor =
    mode === "events" ? { ...scope, mode, sequence: 0 } : { ...scope, mode, ...origin };
  return {
    runId: owner.run_id,
    runStatus: current.status,
    attemptCount: owner.attempt_count ?? null,
    mode,
    expiredAt: null,
    entries,
    olderCursor: first ? writeCursor(first) : null,
    newerCursor: writeCursor(last ?? cursor ?? initialBoundary),
    hasOlder: forward ? Boolean(cursor && !isOrigin(cursor)) : hasMore,
    hasNewer: forward ? hasMore : Boolean(cursor),
  };
}

function expiredPage(
  scope: z.infer<typeof scopeSchema>,
  status: RunTranscriptPage["runStatus"],
  expiredAt: string,
): RunTranscriptPage {
  return {
    runId: scope.runId,
    runStatus: status,
    attemptCount: scope.attemptCount,
    mode: "legacy",
    expiredAt,
    entries: [],
    olderCursor: null,
    newerCursor: writeCursor({ ...scope, mode: "legacy", ...origin }),
    hasOlder: false,
    hasNewer: false,
  };
}

function isTerminal(status: RunTranscriptPage["runStatus"]): boolean {
  return status === "success" || status === "error" || status === "canceled";
}

async function readOwner(input: Input) {
  const { data, error } = await input.supabase.rpc("list_workspace_run_catalog", {
    p_workspace_id: input.workspaceId,
    p_run_id: input.runId,
    p_limit: 1,
  });
  if (error?.code === "P0002") return null;
  if (error) throw error;
  return data?.[0] ?? null;
}

function readCursor(
  raw: string,
  scope: z.infer<typeof scopeSchema>,
  mode: RunTranscriptPage["mode"],
): Cursor {
  let cursor: Cursor;
  try {
    if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new RunTranscriptCursorError();
    cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new RunTranscriptCursorError();
  }
  if (cursor.workspaceId !== scope.workspaceId || cursor.runId !== scope.runId)
    throw new RunTranscriptCursorError();
  if (cursor.attemptCount !== scope.attemptCount || cursor.mode !== mode)
    throw new RunTranscriptResetError();
  return cursor;
}
function writeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function isOrigin(cursor: Cursor): boolean {
  return cursor.mode === "events"
    ? cursor.sequence === 0
    : cursor.createdAt === origin.createdAt && cursor.id === origin.id;
}

function legacyBody(kind: string, text: string): RunTranscriptBody {
  switch (kind) {
    case "user":
    case "assistant":
    case "text":
    case "progress":
    case "tool_use":
    case "completion":
    case "error":
      return { kind: "legacy", payload: { kind, text } };
    case "run_failure": {
      const failure = parseRunFailure(text);
      return {
        kind: "legacy",
        payload: {
          kind,
          text: failure
            ? `${failure.categoryLabel}: ${failure.cause}\n${failure.recovery}`
            : "The recorded failure details are unavailable.",
        },
      };
    }
    default:
      return {
        kind: "legacy",
        payload: {
          kind: "unknown",
          text: "Unrecognized legacy activity. Original content is unavailable.",
        },
      };
  }
}

function mapBodyText(
  body: RunTranscriptBody,
  transform: (text: string, tool: boolean) => string,
): RunTranscriptBody {
  switch (body.kind) {
    case "text":
    case "progress":
      return { ...body, payload: { text: transform(body.payload.text, false) } };
    case "tool_call":
      return {
        ...body,
        payload: {
          tool: transform(body.payload.tool, true),
          input: transform(body.payload.input, true),
        },
      };
    case "tool_result":
      return {
        ...body,
        payload: {
          ...body.payload,
          tool: transform(body.payload.tool, true),
          output: transform(body.payload.output, true),
        },
      };
    case "terminal":
      return {
        ...body,
        payload:
          body.payload.status === "failed"
            ? { ...body.payload, message: transform(body.payload.message, false) }
            : {
                ...body.payload,
                summary: transform(body.payload.summary, false),
                ...(body.payload.finalOutput !== undefined
                  ? { finalOutput: transform(body.payload.finalOutput, false) }
                  : {}),
              },
      };
    case "usage":
      return {
        ...body,
        payload: {
          ...body.payload,
          ...(body.payload.estimationRevision !== undefined
            ? { estimationRevision: transform(body.payload.estimationRevision, false) }
            : {}),
        },
      };
    case "legacy":
      return {
        ...body,
        payload: {
          ...body.payload,
          text: transform(body.payload.text, body.payload.kind === "tool_use"),
        },
      };
    case "capture_gap":
    case "capture_end":
      return body;
  }
}

function boundEntry(entry: RunTranscriptEntry): RunTranscriptEntry {
  const safe = mapBodyText(entry, (text, tool) =>
    tool ? redactRunToolText(text) : redactRunSensitiveText(text),
  );
  const build = (budget: number): RunTranscriptEntry => {
    let remaining = budget;
    let truncated = entry.truncated;
    const body = mapBodyText(safe, (text) => {
      let end = Math.min(text.length, remaining);
      if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
      const clipped = text.slice(0, end);
      remaining -= clipped.length;
      if (clipped.length < text.length) truncated = true;
      return clipped;
    });
    return { ...entry, ...body, truncated };
  };
  const size = (value: RunTranscriptEntry) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const complete = build(RUN_TRANSCRIPT_ENTRY_BYTES);
  if (size(complete) <= RUN_TRANSCRIPT_ENTRY_BYTES) return complete;
  let low = 0;
  let high = RUN_TRANSCRIPT_ENTRY_BYTES;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(build(mid)) <= RUN_TRANSCRIPT_ENTRY_BYTES) low = mid;
    else high = mid - 1;
  }
  return build(low);
}
