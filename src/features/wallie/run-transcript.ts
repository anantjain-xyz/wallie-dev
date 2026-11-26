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
import type { createSupabaseServerClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createSupabaseServerClient>>;
type Input = { supabase: Client; workspaceId: string; runId: string; query?: RunTranscriptQuery };
export type RunTranscriptOwner = {
  run_id: string;
  attempt_count: number | null;
  status: RunTranscriptPage["runStatus"];
  transcript_expired_at: string | null;
};
type ScopedInput = Omit<Input, "runId"> & {
  readOwner: () => Promise<RunTranscriptOwner | null>;
  signal?: AbortSignal;
};
const cursorSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().uuid(),
    runId: z.string().uuid(),
    attemptCount: z.number().int().positive().nullable(),
    sequence: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();
type Cursor = z.infer<typeof cursorSchema>;

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

export class RunTranscriptEventsError extends Error {
  constructor(cause: unknown) {
    super("The transcript events could not be read.", { cause });
    this.name = "RunTranscriptEventsError";
  }
}

export function loadRunTranscript(input: Input): Promise<RunTranscriptPage | null> {
  return loadScopedRunTranscript({ ...input, readOwner: () => readOwner(input) });
}

/** Read a transcript using a caller's current authorization for its exact owner. */
export async function loadScopedRunTranscript(
  input: ScopedInput,
): Promise<RunTranscriptPage | null> {
  const owner = await input.readOwner();
  if (!owner) return null;
  const scope = {
    version: 1,
    workspaceId: input.workspaceId,
    runId: owner.run_id,
    attemptCount: owner.attempt_count ?? null,
    sequence: 0,
  } satisfies Cursor;
  const cursor = input.query?.cursor ? readCursor(input.query.cursor, scope) : null;
  const direction = input.query?.direction ?? "older";
  if (direction === "newer" && !cursor) throw new RunTranscriptCursorError();
  if (owner.transcript_expired_at) {
    return emptyPage(scope, owner.status, owner.transcript_expired_at);
  }
  const limit = Math.min(
    RUN_TRANSCRIPT_MAX_PAGE_SIZE,
    Math.max(1, input.query?.limit ?? RUN_TRANSCRIPT_PAGE_SIZE),
  );
  const forward = direction === "newer";
  const { attemptCount } = scope;
  let entries: RunTranscriptEntry[] = [];
  let hasMore = false;

  if (attemptCount !== null) {
    let query = input.supabase
      .from("agent_run_events")
      .select("sequence, causation_sequence, created_at, kind, payload, schema_version, truncated")
      .eq("workspace_id", input.workspaceId)
      .eq("agent_run_id", scope.runId)
      .eq("attempt_count", attemptCount)
      .order("sequence", { ascending: forward })
      .limit(limit + 1);
    if (cursor) {
      query = forward
        ? query.gt("sequence", cursor.sequence)
        : query.lt("sequence", cursor.sequence);
    }
    const rows = await Promise.resolve(input.signal ? query.abortSignal(input.signal) : query)
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      })
      .catch((error: unknown) => {
        input.signal?.throwIfAborted();
        throw new RunTranscriptEventsError(error);
      });
    hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    if (!forward) pageRows.reverse();
    entries = pageRows.map((row) => {
      const parsed =
        row.schema_version === 1
          ? runTranscriptBodySchema.safeParse({ kind: row.kind, payload: row.payload })
          : null;
      const body: RunTranscriptBody = parsed?.success
        ? parsed.data
        : { kind: "capture_gap", payload: { reason: "unsupported_event" } };
      return boundEntry({
        ...body,
        id: `event:${scope.runId}:${attemptCount}:${row.sequence}`,
        createdAt: row.created_at,
        sequence: row.sequence,
        causationSequence: row.causation_sequence,
        truncated: row.truncated,
      });
    });
  }

  // Recheck current ownership before disclosing event bodies.
  const current = await input.readOwner();
  if (!current) return null;
  if (current.run_id !== scope.runId || (current.attempt_count ?? null) !== attemptCount)
    throw new RunTranscriptResetError();
  if (current.transcript_expired_at || attemptCount === null) {
    return emptyPage(scope, current.status, current.transcript_expired_at ?? null);
  }
  if (!cursor && !isTerminal(owner.status) && isTerminal(current.status)) {
    throw new RunTranscriptResetError();
  }
  const first = entries.at(0);
  const last = entries.at(-1);
  return {
    runId: scope.runId,
    runStatus: current.status,
    attemptCount,
    expiredAt: null,
    entries,
    olderCursor: first ? writeCursor({ ...scope, sequence: first.sequence }) : null,
    newerCursor: writeCursor({ ...scope, sequence: last?.sequence ?? cursor?.sequence ?? 0 }),
    hasOlder: forward ? Boolean(cursor?.sequence) : hasMore,
    hasNewer: forward ? hasMore : Boolean(cursor),
  };
}

function emptyPage(
  scope: Cursor,
  status: RunTranscriptPage["runStatus"],
  expiredAt: string | null,
): RunTranscriptPage {
  return {
    runId: scope.runId,
    runStatus: status,
    attemptCount: scope.attemptCount,
    expiredAt,
    entries: [],
    olderCursor: null,
    newerCursor: writeCursor(scope),
    hasOlder: false,
    hasNewer: false,
  };
}

function isTerminal(status: RunTranscriptPage["runStatus"]): boolean {
  return status === "success" || status === "error" || status === "canceled";
}

async function readOwner(input: Input): Promise<RunTranscriptOwner | null> {
  const { data, error } = await input.supabase.rpc("list_workspace_run_catalog", {
    p_workspace_id: input.workspaceId,
    p_run_id: input.runId,
    p_limit: 1,
  });
  if (error?.code === "P0002") return null;
  if (error) throw error;
  return data?.[0] ?? null;
}

function readCursor(raw: string, scope: Cursor): Cursor {
  let cursor: Cursor;
  try {
    if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new RunTranscriptCursorError();
    cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    throw new RunTranscriptCursorError();
  }
  if (cursor.workspaceId !== scope.workspaceId || cursor.runId !== scope.runId)
    throw new RunTranscriptCursorError();
  if (cursor.attemptCount !== scope.attemptCount) throw new RunTranscriptResetError();
  return cursor;
}

function writeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
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
