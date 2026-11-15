import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadWorkspaceRunCatalogItem,
  loadWorkspaceRunCatalogPage,
  RunCatalogCursorError,
  RunCatalogWorkspaceUnavailableError,
  type CatalogRow,
} from "@/features/wallie/run-catalog";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

const { recovery } = vi.hoisted(() => ({
  recovery: vi.fn(async () => new Map()),
}));
vi.mock("@/features/wallie/run-catalog-recovery", () => ({ loadRunCatalogRecovery: recovery }));

type Client = Awaited<ReturnType<typeof createSupabaseServerClient>>;

const workspaceId = "b1b2c3d4-0001-4000-8000-000000000001";
const otherWorkspaceId = "b1b2c3d4-0001-4000-8000-000000000002";
const sessionId = "b1b2c3d4-0002-4000-8000-000000000001";
const stageId = "b1b2c3d4-0003-4000-8000-000000000001";
const timestamp = "2026-11-14T19:01:10.123456+00:00";

function runRow(index: number, changes: Partial<CatalogRow> = {}): CatalogRow {
  return {
    run_id: `b1b2c3d4-0004-4000-8000-${String(index).padStart(12, "0")}`,
    session_id: sessionId,
    session_number: 42,
    session_title: "Review the catalog",
    job_id: "b1b2c3d4-0005-4000-8000-000000000001",
    attempt_count: index,
    stage_id: stageId,
    stage_name: "Plan",
    model_provider: "codex",
    model_name: "gpt-5",
    status: "success",
    created_at: timestamp,
    started_at: timestamp,
    finished_at: timestamp,
    last_activity_at: timestamp,
    source_recovery_required: false,
    has_events: true,
    has_legacy_messages: true,
    capture_ended: true,
    capture_interrupted: false,
    failure_receipt: "",
    input_tokens: 3,
    output_tokens: 8,
    total_cost_usd: 0.1,
    token_provenance: "measured",
    cost_provenance: "estimated",
    usage_finalized_at: timestamp,
    ...changes,
  };
}

function client(rows: CatalogRow[] = []) {
  const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
  const supabase = { rpc } as unknown as Client;
  return { rpc, input: { supabase, workspaceId, workspaceSlug: "wallie" } };
}

beforeEach(() => vi.clearAllMocks());

describe("workspace run catalog", () => {
  it("passes exact timestamp and tie-breaker through forward pages and hydrates only displayed rows", async () => {
    const [newest, older, lookahead] = [runRow(3), runRow(2), runRow(1)];
    const { rpc, input } = client([newest, older, lookahead]);
    const query = { limit: 2, sessionId, stageId, provider: "codex", status: "success" } as const;

    const first = await loadWorkspaceRunCatalogPage({ ...input, query });
    expect(first.runs.map(({ id }) => id)).toEqual([newest.run_id, older.run_id]);
    expect(first.nextCursor).toBeTruthy();
    expect(recovery).toHaveBeenCalledWith({
      supabase: input.supabase,
      rows: [newest, older],
      workspaceId,
    });
    expect(rpc).toHaveBeenCalledWith("list_workspace_run_catalog", {
      p_workspace_id: workspaceId,
      p_session_id: sessionId,
      p_stage_id: stageId,
      p_provider: "codex",
      p_status: "success",
      p_limit: 3,
    });

    rpc.mockResolvedValueOnce({ data: [lookahead], error: null });
    const second = await loadWorkspaceRunCatalogPage({
      ...input,
      query: { ...query, cursor: first.nextCursor ?? undefined },
    });
    expect(second.runs.map(({ id }) => id)).toEqual([lookahead.run_id]);
    expect(second.nextCursor).toBeNull();
    expect(rpc).toHaveBeenLastCalledWith(
      "list_workspace_run_catalog",
      expect.objectContaining({ p_before_created_at: timestamp, p_before_id: older.run_id }),
    );
  });

  it("rejects malformed and cross-scope cursors before any fetch", async () => {
    const { input, rpc } = client([runRow(2), runRow(1)]);
    const { nextCursor } = await loadWorkspaceRunCatalogPage({
      ...input,
      query: { limit: 1, provider: "codex" },
    });
    rpc.mockClear();
    await expect(
      loadWorkspaceRunCatalogPage({
        ...input,
        workspaceId: otherWorkspaceId,
        query: { cursor: nextCursor!, provider: "codex" },
      }),
    ).rejects.toBeInstanceOf(RunCatalogCursorError);
    await expect(
      loadWorkspaceRunCatalogPage({
        ...input,
        query: { cursor: nextCursor!, provider: "cursor" },
      }),
    ).rejects.toBeInstanceOf(RunCatalogCursorError);
    await expect(
      loadWorkspaceRunCatalogPage({
        ...input,
        query: { cursor: "anything" },
      }),
    ).rejects.toBeInstanceOf(RunCatalogCursorError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    { status: "success", expectedInterrupted: false, receipt: "" },
    { status: "canceled", expectedInterrupted: false, receipt: "" },
    {
      status: "error",
      expectedInterrupted: false,
      receipt: '{"version":1,"code":"agent_exit","category":"agent_exit"}',
    },
    {
      status: "error",
      expectedInterrupted: true,
      receipt: '{"version":1,"code":"timeout","category":"timeout"}',
    },
  ] as const)(
    "looks up the exact $status attempt and exposes only transcript availability",
    async ({ status, expectedInterrupted, receipt }) => {
      const row = runRow(4, { status, failure_receipt: receipt });
      const { input, rpc } = client([row]);
      const item = await loadWorkspaceRunCatalogItem({ ...input, runId: row.run_id });
      expect(rpc).toHaveBeenCalledWith("list_workspace_run_catalog", {
        p_workspace_id: workspaceId,
        p_run_id: row.run_id,
        p_limit: 1,
      });
      expect(item).toMatchObject({
        id: row.run_id,
        sessionRunHref: `/w/wallie/sessions/42#wallie-run-${row.run_id}`,
        attemptCount: 4,
        status,
        interrupted: expectedInterrupted,
        transcript: { hasEvents: true, hasLegacyMessages: true, captureEnded: true },
        usage: { inputTokens: 3, outputTokens: 8, tokenProvenance: "measured", finalized: true },
      });
      expect(item).not.toHaveProperty("messages");
      expect(item).not.toHaveProperty("events");
      expect(item).not.toHaveProperty("jobId");
    },
  );

  it("caps the page and keeps legacy metadata readable without a bound attempt", async () => {
    const legacy = runRow(51, {
      attempt_count: null,
      has_events: false,
      has_legacy_messages: true,
      capture_ended: false,
      input_tokens: null,
      output_tokens: null,
      total_cost_usd: null,
      token_provenance: "unavailable",
      cost_provenance: "unavailable",
      usage_finalized_at: null,
    });
    const { input, rpc } = client([
      legacy,
      ...Array.from({ length: 50 }, (_, i) => runRow(50 - i)),
    ]);
    const page = await loadWorkspaceRunCatalogPage({ ...input, query: { limit: 1000 } });
    expect(rpc).toHaveBeenCalledWith("list_workspace_run_catalog", {
      p_workspace_id: workspaceId,
      p_limit: 51,
    });
    expect(page.runs).toHaveLength(50);
    expect(page.runs[0]).toMatchObject({
      attemptCount: null,
      usage: { inputTokens: null, outputTokens: null, totalCostUsd: null, finalized: false },
      transcript: { hasEvents: false, hasLegacyMessages: true, captureEnded: false },
    });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
  });

  it("distinguishes capture interruption from an interrupted execution", async () => {
    const row = runRow(1, {
      status: "error",
      capture_ended: true,
      capture_interrupted: true,
    });
    const { input } = client([row]);
    expect(await loadWorkspaceRunCatalogItem({ ...input, runId: row.run_id })).toMatchObject({
      status: "error",
      interrupted: false,
      transcript: { captureEnded: true, captureInterrupted: true },
    });
  });

  it("stops recovery reads when the workspace becomes unavailable", async () => {
    const { input, rpc } = client();
    rpc.mockResolvedValueOnce({ data: null, error: { code: "P0002" } });
    await expect(loadWorkspaceRunCatalogPage({ ...input, query: {} })).rejects.toBeInstanceOf(
      RunCatalogWorkspaceUnavailableError,
    );
    expect(recovery).not.toHaveBeenCalled();
  });

  it("returns null and does not query recovery for an unowned or absent run", async () => {
    const { input } = client();
    expect(await loadWorkspaceRunCatalogItem({ ...input, runId: runRow(1).run_id })).toBeNull();
    expect(recovery).not.toHaveBeenCalled();
  });
});
