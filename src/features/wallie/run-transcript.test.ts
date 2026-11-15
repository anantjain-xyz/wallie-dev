import { describe, expect, it, vi } from "vitest";

import {
  loadRunTranscript,
  RunTranscriptCursorError,
  RunTranscriptResetError,
} from "./run-transcript";
import { RUN_TRANSCRIPT_ENTRY_BYTES, runTranscriptQuerySchema } from "./run-transcript-contracts";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

type Client = Awaited<ReturnType<typeof createSupabaseServerClient>>;
const workspaceId = "53400000-0001-4000-8000-000000000001";
const runId = "53400000-0004-4000-8000-000000000001";
const timestamp = "2026-11-14T19:01:10.123456+00:00";
const owner: {
  run_id: string;
  attempt_count: number | null;
  has_events: boolean;
  status: string;
  transcript_expired_at?: string;
} = { run_id: runId, attempt_count: 2, has_events: true, status: "running" };

function client(pages: unknown[][] = [], currentOwner = owner) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const rpc = vi.fn().mockImplementation(async (name: string) => ({
    data: name === "list_run_legacy_transcript" ? (pages.shift() ?? []) : [currentOwner],
    error: null,
  }));
  const from = vi.fn((table: string) => {
    const result = { data: pages.shift() ?? [], error: null };
    const builder = {
      select: (value: string) => record("select", value),
      eq: (key: string, value: unknown) => record("eq", key, value),
      order: (key: string, value: unknown) => record("order", key, value),
      limit: (value: number) => record("limit", value),
      gt: (key: string, value: unknown) => record("gt", key, value),
      lt: (key: string, value: unknown) => record("lt", key, value),
      or: (value: string) => record("or", value),
      then: Promise.resolve(result).then.bind(Promise.resolve(result)),
    };
    function record(method: string, ...args: unknown[]) {
      calls.push({ table, method, args });
      return builder;
    }
    return builder;
  });
  return {
    rpc,
    from,
    calls,
    input: { workspaceId, runId, supabase: { rpc, from } as unknown as Client },
  };
}

function event(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    sequence,
    causation_sequence: null,
    created_at: timestamp,
    kind: "progress",
    payload: { text: `Event ${sequence}` },
    schema_version: 1,
    truncated: false,
    ...overrides,
  };
}
function legacy(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `53400000-0006-4000-8000-${String(index).padStart(12, "0")}`,
    created_at: timestamp,
    kind: "progress",
    message_excerpt: `Legacy ${index}`,
    message_truncated: false,
    ...overrides,
  };
}

describe("run transcript pages", () => {
  it("returns an explicit expiry receipt without reading transcript bodies", async () => {
    const test = client([], {
      ...owner,
      status: "success",
      has_events: false,
      transcript_expired_at: timestamp,
    });
    await expect(loadRunTranscript(test.input)).resolves.toMatchObject({
      expiredAt: timestamp,
      entries: [],
      hasOlder: false,
      hasNewer: false,
    });
    expect(test.from).not.toHaveBeenCalled();
    expect(test.rpc).toHaveBeenCalledTimes(1);
  });

  it("discards page bytes when retention expires the transcript during the read", async () => {
    const test = client([[event(1)]]);
    test.rpc.mockResolvedValueOnce({ data: [owner], error: null }).mockResolvedValueOnce({
      data: [{ ...owner, has_events: false, status: "success", transcript_expired_at: timestamp }],
      error: null,
    });
    await expect(loadRunTranscript(test.input)).resolves.toMatchObject({
      expiredAt: timestamp,
      entries: [],
    });
  });

  it("loads only an exact attempt's newest bounded page in chronological display order", async () => {
    const test = client([[event(3), event(2), event(1)]]);
    const page = await loadRunTranscript({ ...test.input, query: { limit: 2 } });
    expect(page?.entries.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(page).toMatchObject({
      runId,
      attemptCount: 2,
      mode: "events",
      runStatus: "running",
      hasOlder: true,
      hasNewer: false,
    });
    expect(test.rpc).toHaveBeenCalledTimes(2);
    expect(test.rpc).toHaveBeenCalledWith("list_workspace_run_catalog", {
      p_workspace_id: workspaceId,
      p_run_id: runId,
      p_limit: 1,
    });
    expect(test.from).toHaveBeenCalledExactlyOnceWith("agent_run_events");
    expect(test.calls).toEqual(
      expect.arrayContaining([
        { table: "agent_run_events", method: "eq", args: ["workspace_id", workspaceId] },
        { table: "agent_run_events", method: "eq", args: ["agent_run_id", runId] },
        { table: "agent_run_events", method: "eq", args: ["attempt_count", 2] },
        { table: "agent_run_events", method: "limit", args: [3] },
      ]),
    );
  });

  it("uses strict keysets for older and forward pages and retains empty forward boundaries", async () => {
    const test = client([
      [event(3), event(2), event(1)],
      [event(1)],
      [event(4), event(5), event(6)],
      [],
    ]);
    const first = await loadRunTranscript({ ...test.input, query: { limit: 2 } });
    const older = await loadRunTranscript({
      ...test.input,
      query: { limit: 2, cursor: first?.olderCursor ?? undefined },
    });
    expect(older?.entries.map((entry) => entry.sequence)).toEqual([1]);
    expect(test.calls).toContainEqual({
      table: "agent_run_events",
      method: "lt",
      args: ["sequence", 2],
    });
    const newer = await loadRunTranscript({
      ...test.input,
      query: { limit: 2, direction: "newer", cursor: first?.newerCursor },
    });
    expect(newer?.entries.map((entry) => entry.sequence)).toEqual([4, 5]);
    expect(newer?.hasNewer).toBe(true);
    expect(test.calls).toContainEqual({
      table: "agent_run_events",
      method: "gt",
      args: ["sequence", 3],
    });
    const empty = await loadRunTranscript({
      ...test.input,
      query: { direction: "newer", cursor: newer?.newerCursor },
    });
    expect(empty?.entries).toEqual([]);
    expect(empty?.newerCursor).toBe(newer?.newerCursor);
    expect(empty?.hasNewer).toBe(false);
  });

  it("keeps precise legacy timestamp/id ties and never queries event projections for legacy mode", async () => {
    const test = client([[legacy(3), legacy(2), legacy(1)], [legacy(1)]], {
      ...owner,
      has_events: false,
    });
    const first = await loadRunTranscript({ ...test.input, query: { limit: 2 } });
    expect(first?.entries.map((entry) => entry.id)).toEqual([
      `message:${legacy(2).id}`,
      `message:${legacy(3).id}`,
    ]);
    expect(first?.entries[0]).toMatchObject({
      kind: "legacy",
      payload: { kind: "progress", text: "Legacy 2" },
      sequence: null,
    });
    await loadRunTranscript({ ...test.input, query: { cursor: first?.olderCursor ?? undefined } });
    expect(test.from).not.toHaveBeenCalled();
    expect(test.rpc).toHaveBeenCalledWith("list_run_legacy_transcript", {
      p_workspace_id: workspaceId,
      p_run_id: runId,
      p_limit: 31,
      p_direction: "older",
      p_cursor_created_at: timestamp,
      p_cursor_id: legacy(2).id,
    });
  });

  it("provides an origin cursor for an empty transcript and reads its first later message", async () => {
    const test = client([[], [legacy(1)]], { ...owner, attempt_count: null, has_events: false });
    const empty = await loadRunTranscript(test.input);
    expect(empty).toMatchObject({
      entries: [],
      hasOlder: false,
      hasNewer: false,
      olderCursor: null,
    });
    expect(empty?.newerCursor).toBeTruthy();
    expect(empty?.attemptCount).toBeNull();
    const first = await loadRunTranscript({
      ...test.input,
      query: { direction: "newer", cursor: empty?.newerCursor },
    });
    expect(first?.entries).toHaveLength(1);
    expect(first?.hasOlder).toBe(false);
  });

  it("returns null without querying transcript bodies when the run is invisible", async () => {
    const test = client();
    test.rpc.mockResolvedValue({ data: [], error: null });
    expect(await loadRunTranscript(test.input)).toBeNull();
    expect(test.from).not.toHaveBeenCalled();
  });

  it.each(["revoked", "deleting"])(
    "fails closed when access becomes %s during the page read",
    async (reason) => {
      const test = client([[event(1)]]);
      test.rpc.mockResolvedValueOnce({ data: [owner], error: null }).mockResolvedValueOnce(
        reason === "revoked"
          ? { data: [], error: null }
          : {
              data: null,
              error: { code: "P0002", message: "Run catalog workspace is unavailable." },
            },
      );
      expect(await loadRunTranscript(test.input)).toBeNull();
    },
  );

  it("returns the current canceled status with retained activity after a terminal transition", async () => {
    const test = client([[event(1)]]);
    test.rpc
      .mockResolvedValueOnce({ data: [owner], error: null })
      .mockResolvedValueOnce({ data: [{ ...owner, status: "canceled" }], error: null });
    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        workspaceId,
        runId,
        attemptCount: 2,
        mode: "events",
        sequence: 0,
      }),
    ).toString("base64url");
    expect(
      await loadRunTranscript({ ...test.input, query: { cursor, direction: "newer" } }),
    ).toMatchObject({
      runStatus: "canceled",
      entries: [expect.objectContaining({ sequence: 1 })],
    });
  });

  it.each(["success", "error", "canceled"])(
    "requests a fresh initial page when the run becomes %s during its first read",
    async (status) => {
      const test = client([[event(1)]]);
      test.rpc
        .mockResolvedValueOnce({ data: [owner], error: null })
        .mockResolvedValueOnce({ data: [{ ...owner, status }], error: null });
      await expect(loadRunTranscript(test.input)).rejects.toBeInstanceOf(RunTranscriptResetError);
    },
  );

  it("resets the cursor when the first exact event supersedes legacy projections", async () => {
    const test = client([[]], { ...owner, has_events: false });
    const initial = await loadRunTranscript(test.input);
    test.rpc.mockResolvedValue({ data: [owner], error: null });
    await expect(
      loadRunTranscript({
        ...test.input,
        query: { cursor: initial?.newerCursor, direction: "newer" },
      }),
    ).rejects.toBeInstanceOf(RunTranscriptResetError);
    expect(test.from).not.toHaveBeenCalled();
  });

  it("resets if an attempt or source changes during a read", async () => {
    const test = client([[event(1)]]);
    test.rpc
      .mockResolvedValueOnce({ data: [owner], error: null })
      .mockResolvedValueOnce({ data: [{ ...owner, attempt_count: 3 }], error: null });
    await expect(loadRunTranscript(test.input)).rejects.toBeInstanceOf(RunTranscriptResetError);
  });

  it.each(["workspaceId", "runId"])(
    "rejects a cursor from a different %s before reading bodies",
    async (field) => {
      const test = client([[event(1)]]);
      const page = await loadRunTranscript(test.input);
      const decoded = JSON.parse(
        Buffer.from(page?.newerCursor ?? "", "base64url").toString("utf8"),
      );
      decoded[field] = "53400000-0001-4000-8000-000000000099";
      await expect(
        loadRunTranscript({
          ...test.input,
          query: { cursor: Buffer.from(JSON.stringify(decoded)).toString("base64url") },
        }),
      ).rejects.toBeInstanceOf(RunTranscriptCursorError);
      expect(test.from).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "bad cursor",
    "a".repeat(513),
    Buffer.from('{"mode":"events","sequence":-1}').toString("base64url"),
  ])("rejects malformed cursor %s", async (cursor) => {
    const test = client();
    await expect(loadRunTranscript({ ...test.input, query: { cursor } })).rejects.toBeInstanceOf(
      RunTranscriptCursorError,
    );
    expect(test.from).not.toHaveBeenCalled();
  });

  it("caps displayed entries and the query lookahead even for internal callers", async () => {
    const test = client([Array.from({ length: 51 }, (_, index) => event(51 - index))]);
    const page = await loadRunTranscript({ ...test.input, query: { limit: 1000 } });
    expect(page?.entries).toHaveLength(50);
    expect(test.calls).toContainEqual({ table: "agent_run_events", method: "limit", args: [51] });
  });
});

describe("transcript payload boundaries", () => {
  it.each(["user", "assistant"])(
    "keeps readable historical %s messages and the database truncation marker",
    async (kind) => {
      const test = client(
        [[legacy(1, { kind, message_excerpt: "Recorded conversation", message_truncated: true })]],
        { ...owner, has_events: false },
      );
      const page = await loadRunTranscript(test.input);
      expect(page?.entries[0]).toMatchObject({
        kind: "legacy",
        payload: { kind, text: "Recorded conversation" },
        truncated: true,
      });
    },
  );

  it("retains known tool outcomes, causation, usage and capture coverage but removes extra fields", async () => {
    const coverage = {
      adapter: "cursor",
      limitations: ["usage_unavailable"],
      toolCalls: 1,
      toolResults: 1,
      unresolvedToolCalls: 0,
      unmatchedToolResults: 0,
      unsupportedEvents: 1,
      truncatedEvents: 0,
    };
    const test = client([
      [
        event(5, {
          kind: "capture_end",
          payload: {
            status: "interrupted",
            coverage: { ...coverage, private: "private-marker" },
            private: "private-marker",
          },
        }),
        event(4, { kind: "capture_gap", payload: { reason: "normalized_source_only" } }),
        event(3, {
          kind: "usage",
          payload: {
            inputTokens: 2,
            outputTokens: 0,
            provenance: "measured",
            costUsd: 0,
            costProvenance: "measured",
          },
        }),
        event(2, {
          kind: "tool_result",
          causation_sequence: 1,
          payload: {
            tool: "shell",
            output: "denied",
            status: "error",
            outcome: "rejected",
            exitCode: 1,
            private: "private-marker",
          },
        }),
        event(1, { kind: "tool_call", payload: { tool: "shell", input: "pwd" } }),
      ],
    ]);
    const page = await loadRunTranscript(test.input);
    expect(page?.entries.map((entry) => entry.kind)).toEqual([
      "tool_call",
      "tool_result",
      "usage",
      "capture_gap",
      "capture_end",
    ]);
    expect(page?.entries[1]).toMatchObject({
      causationSequence: 1,
      payload: { status: "error", outcome: "rejected", exitCode: 1 },
    });
    expect(page?.entries[4]).toMatchObject({ payload: { status: "interrupted", coverage } });
    expect(JSON.stringify(page)).not.toContain("private-marker");
  });

  it.each([
    { kind: "unknown", payload: { secret: "private-marker" } },
    {
      kind: "tool_result",
      payload: { tool: "shell", status: "success", output: { secret: "private-marker" } },
    },
    { schema_version: 2, payload: { text: "private-marker" } },
    {
      kind: "capture_end",
      payload: { status: "complete", coverage: { secret: "private-marker" } },
    },
  ])("shows a gap for unrecognized event material (%j)", async (overrides) => {
    const test = client([[event(1, overrides)]]);
    const page = await loadRunTranscript(test.input);
    expect(page?.entries[0]).toMatchObject({
      kind: "capture_gap",
      payload: { reason: "unsupported_event" },
    });
    expect(JSON.stringify(page)).not.toContain("private-marker");
  });

  it("bounds artifact text by serialized UTF-8 bytes and marks any truncation", async () => {
    const test = client([
      [
        event(1, {
          kind: "terminal",
          payload: {
            status: "completed",
            summary: "Delivered",
            finalOutput: "界\n\u0001".repeat(5000),
          },
        }),
      ],
    ]);
    const page = await loadRunTranscript(test.input);
    expect(page?.entries[0].truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page?.entries[0]))).toBeLessThanOrEqual(
      RUN_TRANSCRIPT_ENTRY_BYTES,
    );
    expect(page?.entries[0]).toMatchObject({
      kind: "terminal",
      payload: { status: "completed", summary: "Delivered" },
    });
  });

  it("sanitizes legacy text and exposes only typed failure metadata", async () => {
    const test = client(
      [
        [
          legacy(3, { kind: "unknown-kind", message_excerpt: "private-marker" }),
          legacy(2, {
            kind: "run_failure",
            message_excerpt:
              '{"version":1,"category":"timeout","code":"timeout","private":"private-marker"}',
          }),
          legacy(1, {
            kind: "error",
            message_excerpt: "Authorization: Bearer fixture-secret-token-value",
          }),
        ],
      ],
      { ...owner, has_events: false },
    );
    const page = await loadRunTranscript(test.input);
    expect(page?.entries[0]).toMatchObject({
      payload: { text: expect.stringMatching(/\[redacted\]/i) },
    });
    expect(page?.entries[1]).toMatchObject({
      payload: { kind: "run_failure", text: expect.stringContaining("Timeout") },
    });
    expect(page?.entries[2]).toMatchObject({ payload: { kind: "unknown" } });
    expect(JSON.stringify(page)).not.toContain("private-marker");
    expect(JSON.stringify(page)).not.toContain("fixture-secret-token-value");
  });
});

describe("transcript request contract", () => {
  it("allows an initial older page and rejects forward pages without a boundary", () => {
    expect(runTranscriptQuerySchema.parse({ direction: "older", limit: "50" })).toEqual({
      direction: "older",
      limit: 50,
    });
    expect(runTranscriptQuerySchema.safeParse({ direction: "newer" }).success).toBe(false);
  });
  it.each([
    { limit: "51" },
    { offset: "1" },
    { attemptCount: "1" },
    { mode: "legacy" },
    { cursor: "invalid cursor" },
  ])("rejects unsupported query input %j", (query) => {
    expect(runTranscriptQuerySchema.safeParse(query).success).toBe(false);
  });
});
